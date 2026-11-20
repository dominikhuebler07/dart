// Realistischer Härtetest für die Pfeilerkennung (node test/bench.js)
// Simuliert: Handy schräg neben der Scheibe, Zoom-Ausschnitt ("⤢ Scheibe"), Zahlenring + Metall-Befestigungen am Rand,
// minimale Erschütterung beim Einschlag (Sub-Pixel), Belichtungs-/Farbschwankungen, ungleichmäßiges Licht,
// echte Pfeilform (dünne silberne Spitze, Barrel, Schaft, Flight), schräg steckende Pfeile, 3 Pfeile pro Aufnahme.
const Board = require('../public/board.js');
const F = require('../public/boardfinder.js');
const Det = require('../public/detector.js');

// ---------- Zufall mit Startwert (reproduzierbar) ----------
function rng(seed) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------- Kamera: volles Handybild 1920x1080, verarbeitet wird der Zoom-Ausschnitt ----------
const JIT = Number(process.env.JIT || 1);
const EDGE = process.env.EDGE === '1'; // Treffer gezielt knapp neben Drähten
const FULL_W = 1920, FULL_H = 1080, F_FULL = 1371; // ~70° Bildwinkel (Hauptkamera)
function makeCam(pos, look, view, w, h) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const nrm = (a) => { const l = Math.hypot(...a); return a.map((v) => v / l); };
  const zc = nrm(sub(look, pos)), xc = nrm(cross([0, 1, 0], zc)), yc = cross(zc, xc);
  const full = (X) => {
    const d = sub(X, pos);
    const P = [xc, yc, zc].map((r) => r[0] * d[0] + r[1] * d[1] + r[2] * d[2]);
    return [(F_FULL * P[0]) / P[2] + FULL_W / 2, (F_FULL * P[1]) / P[2] + FULL_H / 2, P[2]];
  };
  const toProc = ([u, v, z]) => [((u / FULL_W - view.x) / view.w) * w, ((v / FULL_H - view.y) / view.h) * h, z];
  const project = (X) => toProc(full(X));
  const imgPts = F.CAL_DST.map(([x, y]) => project([x, y, 0]).slice(0, 2));
  const fProc = (F_FULL * w) / (view.w * FULL_W);
  return { full, project, imgPts, fProc, w, h, view };
}
// Zoom wie die Taste "⤢ Scheibe": Ausschnitt um die Scheibe (r = 200 mm) mit etwas Rand
function zoomView(pos, look) {
  const c = makeCam(pos, look, { x: 0, y: 0, w: 1, h: 1 }, FULL_W, FULL_H);
  let x0 = 1, x1 = 0, y0 = 1, y1 = 0;
  for (let a = 0; a < 360; a += 10) {
    const [u, v] = c.project([...Board.polar(200, a), 0]);
    x0 = Math.min(x0, u / FULL_W); x1 = Math.max(x1, u / FULL_W); y0 = Math.min(y0, v / FULL_H); y1 = Math.max(y1, v / FULL_H);
  }
  const z = Math.min(5, 0.94 / Math.max(x1 - x0, y1 - y0)), half = 0.5 / z;
  const cx = Math.min(1 - half, Math.max(half, (x0 + x1) / 2)), cy = Math.min(1 - half, Math.max(half, (y0 + y1) / 2));
  return { x: cx - half, y: cy - half, w: 2 * half, h: 2 * half };
}

// ---------- Szene ----------
const C = {
  red: [196, 48, 42], green: [34, 138, 72], dark: [30, 29, 28], cream: [222, 208, 172],
  surround: [24, 24, 24], wall: [160, 156, 148], num: [228, 228, 228], metal: [205, 205, 210], screw: [60, 60, 64], wire: [170, 170, 172],
};
function sceneColor(bx, by) {
  const r = Math.hypot(bx, by);
  // Metall-Befestigungen (Halteklammern) am Rand bei 45°, 135°, 225°, 315°
  let deg = (Math.atan2(bx, -by) * 180) / Math.PI; if (deg < 0) deg += 360;
  for (const a of [45, 135, 225, 315]) {
    const da = Math.abs(((deg - a + 540) % 360) - 180) * (Math.PI / 180) * r;
    if (r > 196 && r < 262 && da < 13) {
      if (Math.hypot(da, r - 238) < 3.5) return C.screw;
      return C.metal;
    }
  }
  if (r > 262) return C.wall;
  if (r > 170) {
    // Zahlenring: weiße Blöcke mittig in jedem Segment, plus Drahtring
    if (Math.abs(r - 172) < 1) return C.wire;
    const seg = Math.round(deg / 18) % 20, off = deg - seg * 18;
    if (r > 182 && r < 200 && Math.abs(off) < 4.2 && !(Math.abs(off) < 1.2 && r > 186 && r < 196)) return C.num;
    return C.surround;
  }
  const d = Board.score(bx, by);
  // Drähte (Segmentgrenzen und Ringe)
  const segPos = ((deg + 9) % 18);
  if ((segPos < 0.35 || segPos > 17.65) && r > 15.9 && r * Math.sin((Math.min(segPos, 18 - segPos) * Math.PI) / 180) < 0.6) return C.wire;
  for (const rr of [6.35, 15.9, 99, 107, 162, 170]) if (Math.abs(r - rr) < 0.5) return C.wire;
  const i = Board.ORDER.indexOf(d.seg), even = i % 2 === 0;
  if (d.seg === 25) return d.mult === 2 ? C.red : C.green;
  return d.mult >= 2 ? (even ? C.red : C.green) : even ? C.dark : C.cream;
}

// Szene doppelt so groß rendern (2x), Pfeile hineinzeichnen, dann herunterskalieren (= Kantenglättung)
function renderBase2x(cam) {
  const W = cam.w * 2, H = cam.h * 2;
  const Hi2b = F.invertH(F.solveH(F.CAL_DST, cam.imgPts.map(([x, y]) => [x * 2, y * 2])));
  const img = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [bx, by] = F.applyH(Hi2b, x + 0.5, y + 0.5);
    const c = sceneColor(bx, by), j = (y * W + x) * 3;
    img[j] = c[0]; img[j + 1] = c[1]; img[j + 2] = c[2];
  }
  return { img, W, H };
}

// Pfeil: Spitze (dünn, silbern), Barrel, Schaft, Flight. axis = Richtung von der Spitze nach hinten (z < 0 = Richtung Raum)
function drawDart2x(base, cam, dart) {
  const { img, W, H } = base;
  const { bx, by, axis, pointLen, colors } = dart;
  const len = pointLen + 45 + 32 + 36;
  // Spitze läuft auf den letzten 5 mm spitz zu (echte Steeldart-Spitze), Barrel vorne abgerundet
  const seg = (t) => t < pointLen ? ['point', 1.2 * Math.min(1, 0.25 + t / 5)] : t < pointLen + 45 ? ['barrel', 3.5 * Math.min(1, 0.45 + (t - pointLen) / 6)] : t < pointLen + 77 ? ['shaft', 2.4] : ['flight', Math.min(16, 2.4 + (t - pointLen - 77) * 0.9)];
  for (let t = 0; t <= len; t += 0.35) {
    const X = [bx + axis[0] * t, by + axis[1] * t, axis[2] * t];
    const [u, v, z] = cam.project(X);
    const [part, rad] = seg(t);
    const col = colors[part];
    const r = Math.max(0.5, (rad * cam.fProc * 2) / z);
    const U = u * 2, V = v * 2;
    for (let yy = Math.floor(V - r); yy <= Math.ceil(V + r); yy++) for (let xx = Math.floor(U - r); xx <= Math.ceil(U + r); xx++) {
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const dd = Math.hypot(xx + 0.5 - U, yy + 0.5 - V);
      if (dd > r) continue;
      if (t < 1e-9 && dd > 0.3) continue; // keine Rundung über die Spitze hinaus
      const shade = part === 'flight' ? 1 : 0.8 + 0.35 * (1 - dd / r); // runde Form: Mitte heller
      const j = (yy * W + xx) * 3;
      img[j] = col[0] * shade; img[j + 1] = col[1] * shade; img[j + 2] = col[2] * shade;
    }
  }
}

// herunterskalieren + Belichtung, Farbstich, Lichtverlauf, Rauschen
function finish(base, w, h, R, dist = {}) {
  const { img, W } = base;
  const gain = dist.gain ?? 1, tint = dist.tint ?? [1, 1, 1], grad = dist.grad ?? [0, 0], noise = dist.noise ?? 0;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const g = gain * (1 + grad[0] * (x / w - 0.5) + grad[1] * (y / h - 0.5));
    for (let k = 0; k < 3; k++) {
      let s = 0;
      for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) s += img[((2 * y + oy) * W + 2 * x + ox) * 3 + k];
      rgba[(y * w + x) * 4 + k] = (s / 4) * g * tint[k] + (R() - 0.5) * 2 * noise;
    }
    rgba[(y * w + x) * 4 + 3] = 255;
  }
  return rgba;
}

const COLORS = {
  point: [[168, 168, 172], [150, 150, 155], [190, 190, 192]],
  barrel: [[92, 94, 98], [140, 140, 146], [70, 72, 76]],
  shaft: [[28, 28, 30], [175, 175, 180], [200, 40, 40]],
  flight: [[30, 90, 210], [235, 225, 40], [20, 20, 22], [240, 240, 240], [210, 40, 40]],
};

const SETUPS = [
  { name: 'links seitlich, nah an der Wand', pos: [-520, 120, -330] },
  { name: 'rechts unten', pos: [420, 330, -480] },
  { name: 'unten mittig', pos: [30, 480, -420] },
  { name: 'oben rechts', pos: [380, -380, -520] },
  { name: 'rechts, flach', pos: [600, 60, -260] },
];

function run(opts = {}) {
  const verbose = opts.verbose !== false;
  const R = rng(opts.seed || 7);
  const w = opts.w || 800, h = Math.round((w * 9) / 16);
  let total = 0, right = 0, errs = [], fp = 0, fpTrials = 0, missed = 0;
  const along = [], perp = [];
  const lines = [];
  for (const S of SETUPS) {
    const look = [0, 0, 0];
    const view = zoomView(S.pos, look);
    const camAt = (jit) => makeCam(S.pos, [look[0] + jit[0], look[1] + jit[1], 0], view, w, h);
    const cam = camAt([0, 0]);
    const baseCache = new Map();
    const baseFor = (jit) => {
      const k = jit.join(',');
      if (!baseCache.has(k)) baseCache.set(k, renderBase2x(camAt(jit)));
      return baseCache.get(k);
    };
    const det = new Det.DartDetector({});
    let cur = null;
    det.w = w; det.h = h; det.cur = new Uint8Array(w * h); det.tmp = new Uint8Array(w * h);
    det.view = view;
    det.ensureSize = () => true;
    // Kamerarauschen pro Bild neu (wie bei einer echten Kamera)
    const NR = rng((opts.seed || 7) * 7919 + 13), NOISE = Number(process.env.NOISE || 5);
    let noisy = null;
    det.grab = () => {
      if (!noisy || noisy.length !== cur.length) noisy = new Uint8ClampedArray(cur.length);
      for (let i = 0; i < cur.length; i += 4) { noisy[i] = cur[i] + (NR() - 0.5) * 2 * NOISE; noisy[i + 1] = cur[i + 1] + (NR() - 0.5) * 2 * NOISE; noisy[i + 2] = cur[i + 2] + (NR() - 0.5) * 2 * NOISE; noisy[i + 3] = 255; }
      det.rgba = noisy; det.toGray(noisy);
    };
    if (opts.configure) opts.configure(det);
    if (process.env.NOAVG === '1') det.averaging = false;
    const frame = (jit, darts, dist) => {
      const b0 = baseFor(jit);
      const b = { img: Float32Array.from(b0.img), W: b0.W, H: b0.H };
      const c = camAt(jit);
      darts.forEach((d) => drawDart2x(b, c, d));
      return finish(b, w, h, R, dist);
    };
    const tickN = (n) => { for (let i = 0; i < n; i++) det.tick(); };
    // Kalibrieren
    cur = frame([0, 0], [], {});
    det.grab();
    const ac = det.autoCalibrate();
    if (!ac) { lines.push(`${S.name}: Scheibe NICHT gefunden`); continue; }
    det.setCalibration(process.env.TRUECAL === '1' ? cam.imgPts.map(([x, y]) => [x / w, y / h]) : ac.pts);
    det.phase = 'throw';
    // Kalibriergenauigkeit: Punkte auf der Scheibe mit der echten Kamera abbilden und zurückrechnen
    let calErr = 0;
    for (let r = 20; r <= 170; r += 30) for (let a = 0; a < 360; a += 30) {
      const [bx, by] = Board.polar(r, a), [u, v] = cam.project([bx, by, 0]);
      const [ex, ey] = F.applyH(det.H, u / w, v / h);
      calErr = Math.max(calErr, Math.hypot(ex - bx, ey - by));
    }
    S.calErr = calErr;
    tickN(4);
    let got = [];
    det.cb = { onDart: (d) => got.push(d), onStatus: (t) => (det._log = (det._log || []).concat(t)) };
    const res = [];
    const disturb = () => ({
      jit: [(R() - 0.5) * 0.8 * JIT, (R() - 0.5) * 0.8 * JIT], // Erschütterung (bis ~0,8 px × JIT)
      dist: { gain: 1 + (R() - 0.5) * 0.08, tint: [1 + (R() - 0.5) * 0.04, 1, 1 + (R() - 0.5) * 0.04], grad: [(R() - 0.5) * 0.08, (R() - 0.5) * 0.08] },
    });
    // a) Fehlalarm-Test: nichts wird geworfen, nur Erschütterung/Licht
    for (let k = 0; k < 4; k++) {
      cur = frame([0, 0], [], {}); tickN(4); det.startTurn();
      got = [];
      const z = disturb();
      det._fpWatch = true; cur = frame(z.jit, [], z.dist); tickN(8); det._fpWatch = false;
      fpTrials++;
      if (got.length) { fp += got.length; res.push(`FEHLALARM(${Board.label(got[0])})`); }
    }
    // b) 4 Aufnahmen à 3 Pfeile
    for (let turn = 0; turn < 4; turn++) {
      cur = frame([0, 0], [], {}); tickN(4); det.startTurn();
      const darts = [];
      for (let k = 0; k < 3; k++) {
        // Zielpunkt: zufällig, aber nicht direkt auf einem Draht (sonst ist "richtig" Glückssache)
        let bx, by;
        if (opts.edge ?? EDGE) {
          // knapp neben einem Draht: Ring-Draht oder Segment-Draht, Abstand 0,3–2,5 mm
          const gap = 0.3 + R() * 2.2, side = R() < 0.5 ? -1 : 1;
          if (R() < 0.5) {
            const ring = [15.9, 99, 107, 162, 170][Math.floor(R() * 5)];
            [bx, by] = Board.polar(ring + side * gap, R() * 360);
          } else {
            const rr = 20 + R() * 145, seg = Math.floor(R() * 20), ang = seg * 18 + 9 + (side * gap / rr) * (180 / Math.PI);
            [bx, by] = Board.polar(rr, ang);
          }
        } else for (;;) {
          const rr = Math.sqrt(R()) * 165, aa = R() * 360;
          [bx, by] = Board.polar(rr, aa);
          const segOff = Math.abs(((aa + 9) % 18) - 9), wireDist = Math.min(...[6.35, 15.9, 99, 107, 162, 170].map((q) => Math.abs(rr - q)));
          if (wireDist > 2.2 && (rr < 15.9 || segOff * (Math.PI / 180) * rr < 9 - 2.2)) break;
        }
        const tx = (R() - 0.5) * 0.6, ty = (R() - 0.3) * 0.6;
        const nz = Math.hypot(tx, ty, 1);
        const pick = (a) => a[Math.floor(R() * a.length)];
        darts.push({ bx, by, axis: [tx / nz, ty / nz, -1 / nz], pointLen: 12 + R() * 10,
          colors: { point: pick(COLORS.point), barrel: pick(COLORS.barrel), shaft: pick(COLORS.shaft), flight: pick(COLORS.flight) } });
        got = []; det._log = [];
        const z = disturb();
        cur = frame(z.jit, darts, z.dist); tickN(8);
        const want = Board.score(bx, by);
        if (opts.onThrow) opts.onThrow({ det, rgba: cur, cam: camAt([0, 0]), dart: darts[darts.length - 1], got: got[got.length - 1], want, setup: S.name, idx: total });
        total++;
        const g = got[got.length - 1];
        if (!g) { missed++; res.push(`${Board.label(want)}≠—`); continue; }
        const e = Math.hypot(g.x - bx, g.y - by);
        errs.push(e);
        // Fehler im Bild zerlegen: entlang der Pfeilachse (+ = Richtung Flight, also "zu kurz") und quer dazu
        { const c0 = camAt([0, 0]), d = darts[darts.length - 1];
          const t0 = c0.project([bx, by, 0]), t1 = c0.project([bx + d.axis[0] * 20, by + d.axis[1] * 20, d.axis[2] * 20]);
          const gp = c0.project([g.x, g.y, 0]);
          const L = Math.hypot(t1[0] - t0[0], t1[1] - t0[1]) || 1, ux = (t1[0] - t0[0]) / L, uy = (t1[1] - t0[1]) / L;
          const ex = gp[0] - t0[0], ey = gp[1] - t0[1];
          along.push(ex * ux + ey * uy); perp.push(-ex * uy + ey * ux); }
        if (Board.label(g) === Board.label(want)) { right++; res.push(Board.label(want)); }
        else res.push(`${Board.label(want)}≠${Board.label(g)}(${e.toFixed(0)}mm)`);
      }
    }
    lines.push(`${S.name.padEnd(32)} [Kalibrierung ±${S.calErr.toFixed(1)} mm] ${res.join(' ')}`);
  }
  errs.sort((a, b) => a - b);
  const med = errs.length ? errs[Math.floor(errs.length / 2)] : NaN;
  const p90 = errs.length ? errs[Math.floor(errs.length * 0.9)] : NaN;
  const summary = { total, right, missed, fp, fpTrials, median: med, p90, along, perp };
  if (verbose) {
    lines.forEach((l) => console.log(l));
    console.log(`\nRichtig: ${right}/${total} (${((right / total) * 100).toFixed(0)} %) · nicht erkannt: ${missed} · Fehlalarme: ${fp} bei ${fpTrials} Leerversuchen`);
    console.log(`Abweichung Spitze: Median ${med.toFixed(1)} mm · 90 % unter ${p90.toFixed(1)} mm`);
    const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length), sd = (a) => Math.sqrt(mean(a.map((x) => (x - mean(a)) ** 2)));
    console.log(`Bildfehler (Pixel): entlang Achse ${mean(along).toFixed(2)} ± ${sd(along).toFixed(2)} (+ = zu kurz), quer ${mean(perp).toFixed(2)} ± ${sd(perp).toFixed(2)}`);
    const q = (a, p) => { const b = a.map(Math.abs).sort((x, y) => x - y); return b[Math.floor(b.length * p)] || 0; };
    console.log(`Bildfehler |Pixel|: entlang Median ${q(along, 0.5).toFixed(2)} / 80 % ${q(along, 0.8).toFixed(2)} · quer Median ${q(perp, 0.5).toFixed(2)} / 80 % ${q(perp, 0.8).toFixed(2)}`);
  }
  return summary;
}

module.exports = { run, makeCam, zoomView, renderBase2x, finish, rng, SETUPS, drawDart2x };
if (require.main === module) run({ seed: Number(process.argv[2]) || 7, w: Number(process.env.W) || 800 });
