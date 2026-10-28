// Findet die Dartscheibe selbst im Bild – über die roten und grünen Ringe (Double, Triple, Bull).
// Wird für die automatische Kalibrierung UND fürs laufende Nachführen benutzt, wenn die Kamera verrutscht.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root.Board || require('./board.js'));
  else root.BoardFinder = factory(root.Board);
})(typeof self !== 'undefined' ? self : this, function (Board) {
  // Kalibrierpunkte: äußerer Rand des Doppelrings mittig bei 20 (oben), 6 (rechts), 3 (unten), 11 (links)
  const CAL_DST = [[0, -170], [170, 0], [0, 170], [-170, 0]];

  // ---------- Homographie ----------
  function gauss(A, b) {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      if (Math.abs(M[c][c]) < 1e-12) return null;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map((row, i) => row[n] / row[i]);
  }
  function solveH(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const h = gauss(A, b);
    return h ? [...h, 1] : null;
  }
  function applyH(H, x, y) {
    const w = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
  }
  function invertH(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-15) return null;
    return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
  }

  // ---------- Farbkarten ----------
  // Rot-/Grün-Anteil pro Pixel, unabhängig von der Helligkeit (0..~0.8)
  function colorMaps(rgba, w, h) {
    const R = new Float32Array(w * h), G = new Float32Array(w * h);
    for (let i = 0, j = 0; i < w * h; i++, j += 4) {
      const r = rgba[j], g = rgba[j + 1], b = rgba[j + 2];
      const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
      const k = 1 / (mx + 40);
      const dr = r - (g > b ? g : b), dg = g - (r > b ? r : b);
      R[i] = dr > 0 ? dr * k : 0;
      G[i] = dg > 0 ? dg * k : 0;
    }
    return { R, G, w, h };
  }

  function boxBlur(src, w, h, r) {
    if (r <= 0) return src;
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      let s = 0;
      const o = y * w;
      for (let x = -r; x <= r; x++) s += src[o + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[o + x] = s / (2 * r + 1);
        s += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = s / (2 * r + 1);
        s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
    return out;
  }
  const blurMaps = (m, r) => ({ R: boxBlur(m.R, m.w, m.h, r), G: boxBlur(m.G, m.w, m.h, r), w: m.w, h: m.h });

  // ---------- Modell der Scheibe: Messpunkte mit erwarteter Farbe ----------
  // [x_mm, y_mm, Gewicht Rot, Gewicht Grün]
  const SAMPLES = (() => {
    const s = [];
    let pos = 0;
    const add = (r, a, wR, wG) => {
      const [x, y] = Board.polar(r, a);
      s.push(x, y, wR, wG);
      pos += Math.max(0, wR) + Math.max(0, wG);
    };
    for (let i = 0; i < 20; i++) {
      const red = i % 2 === 0; // 20, 18, 13 … haben rote Ringe
      for (const off of [-7, -4, 0, 4, 7]) {
        const a = i * 18 + off;
        for (const r of [163.5, 166, 168.5, 100.5, 103, 105.5]) add(r, a, red ? 1 : -1, red ? -1 : 1);
        for (const r of [158, 174, 95, 111, 60, 135]) add(r, a, -0.7, -0.7);
      }
    }
    for (let a = 0; a < 360; a += 45) { add(2.5, a, 1, -1); add(11, a, -1, 1); add(20, a, -0.7, -0.7); }
    return { data: new Float32Array(s), pos };
  })();

  function sample(map, w, h, x, y) {
    if (!(x >= 0 && y >= 0 && x < w - 1 && y < h - 1)) return 0;
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
    return (map[i] * (1 - fx) + map[i + 1] * fx) * (1 - fy) + (map[i + w] * (1 - fx) + map[i + w + 1] * fx) * fy;
  }

  // Wie gut passt die Scheibe (Board->Bild-Homographie in Pixeln) zu den Farben? ~0 = gar nicht, ~0.5+ = sehr gut
  function scoreH(maps, Hb2i) {
    const { R, G, w, h } = maps, d = SAMPLES.data;
    let s = 0;
    for (let k = 0; k < d.length; k += 4) {
      const x = d[k], y = d[k + 1];
      const den = Hb2i[6] * x + Hb2i[7] * y + Hb2i[8];
      if (den <= 0) return -1;
      const u = (Hb2i[0] * x + Hb2i[1] * y + Hb2i[2]) / den, v = (Hb2i[3] * x + Hb2i[4] * y + Hb2i[5]) / den;
      s += sample(R, w, h, u, v) * d[k + 2] + sample(G, w, h, u, v) * d[k + 3];
    }
    return s / SAMPLES.pos;
  }

  const ptsToH = (p) => solveH(CAL_DST, [[p[0], p[1]], [p[2], p[3]], [p[4], p[5]], [p[6], p[7]]]);
  function scorePts(maps, p) {
    const H = ptsToH(p);
    return H ? scoreH(maps, H) : -1;
  }

  // ---------- Nelder-Mead (maximiert f) ----------
  function nelderMead(f, x0, step, iters) {
    const n = x0.length;
    let S = [x0.slice()];
    for (let i = 0; i < n; i++) { const x = x0.slice(); x[i] += step; S.push(x); }
    let F = S.map(f);
    for (let it = 0; it < iters; it++) {
      const idx = F.map((_, i) => i).sort((a, b) => F[b] - F[a]);
      S = idx.map((i) => S[i]); F = idx.map((i) => F[i]);
      const c = new Array(n).fill(0);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += S[i][j] / n;
      const worst = S[n];
      const at = (t) => c.map((cj, j) => cj + t * (cj - worst[j]));
      const xr = at(1), fr = f(xr);
      if (fr > F[0]) {
        const xe = at(2), fe = f(xe);
        if (fe > fr) { S[n] = xe; F[n] = fe; } else { S[n] = xr; F[n] = fr; }
      } else if (fr > F[n - 1]) {
        S[n] = xr; F[n] = fr;
      } else {
        const xc = at(fr > F[n] ? 0.5 : -0.5), fc = f(xc);
        if (fc > Math.max(fr, F[n])) { S[n] = xc; F[n] = fc; }
        else {
          for (let i = 1; i <= n; i++) { S[i] = S[i].map((v, j) => S[0][j] + 0.5 * (v - S[0][j])); F[i] = f(S[i]); }
        }
      }
      // Abbruch, wenn der Simplex sehr klein ist
      let spread = 0;
      for (let i = 1; i <= n; i++) for (let j = 0; j < n; j++) spread = Math.max(spread, Math.abs(S[i][j] - S[0][j]));
      if (spread < 0.05) break;
    }
    let b = 0;
    for (let i = 1; i <= n; i++) if (F[i] > F[b]) b = i;
    return { x: S[b], f: F[b] };
  }

  // ---------- Feinanpassung ----------
  const boardRadiusPx = (pts) => (Math.hypot(pts[0][0] - pts[2][0], pts[0][1] - pts[2][1]) + Math.hypot(pts[1][0] - pts[3][0], pts[1][1] - pts[3][1])) / 4;

  // Farbkarten in mehreren Unschärfe-Stufen (grob -> fein), zwischengespeichert pro Aufruf
  function pyramid(maps) {
    const cache = new Map();
    return (r) => {
      r = Math.max(1, Math.round(r));
      if (!cache.has(r)) cache.set(r, blurMaps(maps, r));
      return cache.get(r);
    };
  }

  // pts: 4 Bildpunkte (Pixel) der Kalibrierpunkte. search: Suchradius (Pixel) für eine grobe Verschiebung.
  function refine(maps, pts, opts = {}) {
    const lvl = opts.pyr || pyramid(maps);
    const R = boardRadiusPx(pts);
    const radii = opts.coarse ? [R / 12, R / 30, 1] : [Math.max(2, R / 35), 1];
    let p = pts.flat();
    const startScore = scorePts(lvl(1), p);
    if (opts.search) {
      const m = lvl(Math.max(2, R / 30));
      let best = { f: scorePts(m, p), dx: 0, dy: 0 };
      const st = Math.max(2, Math.round(opts.search / 12)), K = Math.ceil(opts.search / st);
      for (let iy = -K; iy <= K; iy++) for (let ix = -K; ix <= K; ix++) {
        const dx = ix * st, dy = iy * st;
        const f = scorePts(m, p.map((v, i) => v + (i % 2 ? dy : dx)));
        if (f > best.f) best = { f, dx, dy };
      }
      p = p.map((v, i) => v + (i % 2 ? best.dy : best.dx));
    }
    // nur grob vorsuchen, wenn die alte Lage nicht schon gut passt
    const skipCoarse = !opts.search && !opts.coarse && startScore > 0.3;
    let fine = null;
    for (const r of radii) {
      if (r > 1 && skipCoarse) continue;
      const m = lvl(r);
      fine = nelderMead((x) => scorePts(m, x), p, r > 1 ? Math.max(2, r * 1.2) : 1.5, 500);
      p = fine.x;
    }
    const again = nelderMead((x) => scorePts(lvl(1), x), p, 0.7, 400);
    if (again.f >= fine.f) fine = again;
    return { pts: [[fine.x[0], fine.x[1]], [fine.x[2], fine.x[3]], [fine.x[4], fine.x[5]], [fine.x[6], fine.x[7]]], quality: fine.f, startScore };
  }

  // Die 20 so legen, dass sie im Bild oben ist (Drehung in 36°-Schritten ändert die Farbpassung nicht)
  function orientUp(pts) {
    const Hb2i = solveH(CAL_DST, pts), Hi2b = invertH(Hb2i);
    const c = applyH(Hb2i, 0, 0);
    const top = applyH(Hi2b, c[0], c[1] - 20);
    const k = Math.round(((Math.atan2(top[0], -top[1]) * 180) / Math.PI) / 36);
    if (!k) return pts;
    return CAL_DST.map((_, i) => applyH(Hb2i, ...Board.polar(170, i * 90 + k * 36)));
  }

  // ---------- Automatische Suche ohne Vorwissen ----------
  function autoFind(rgba, w, h) {
    const maps = colorMaps(rgba, w, h);
    const lvl = pyramid(maps);
    const m1 = lvl(1);
    // 1) farbige Pixel sammeln und Ellipse schätzen (robust in mehreren Runden)
    let cx = w / 2, cy = h / 2, inv = null, cov = null, n = 0;
    for (let round = 0; round < 4; round++) {
      let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
      n = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (m1.R[i] + m1.G[i] < 0.18) continue;
        if (inv) {
          const dx = x - cx, dy = y - cy;
          if ((inv[0] * dx * dx + 2 * inv[1] * dx * dy + inv[2] * dy * dy) / 2 > 2.1) continue; // > ~210 mm vom Zentrum
        }
        sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; n++;
      }
      if (n < 150) return null;
      cx = sx / n; cy = sy / n;
      cov = [sxx / n - cx * cx, sxy / n - cx * cy, syy / n - cy * cy];
      const det = cov[0] * cov[2] - cov[1] * cov[1];
      if (det <= 0) return null;
      inv = [cov[2] / det, -cov[1] / det, cov[0] / det];
    }
    // 2) Ellipse -> affine Abbildung (Kreis mit RMS-Radius ~145 mm der farbigen Ringe)
    const [a, b, c] = cov;
    const dt = Math.sqrt(Math.max(0, ((a - c) / 2) ** 2 + b * b));
    const l1 = (a + c) / 2 + dt, l2 = (a + c) / 2 - dt;
    if (l2 <= 0) return null;
    const ang = 0.5 * Math.atan2(2 * b, a - c);
    const v1 = [Math.cos(ang), Math.sin(ang)], v2 = [-Math.sin(ang), Math.cos(ang)];
    const s1 = Math.sqrt(2 * l1) / 145, s2 = Math.sqrt(2 * l2) / 145;
    const M = [
      s1 * v1[0] * v1[0] + s2 * v2[0] * v2[0], s1 * v1[0] * v1[1] + s2 * v2[0] * v2[1],
      s1 * v1[1] * v1[0] + s2 * v2[1] * v2[0], s1 * v1[1] * v1[1] + s2 * v2[1] * v2[1],
    ];
    const affine = (th) => {
      const co = Math.cos(th), si = Math.sin(th);
      return [M[0] * co + M[1] * si, -M[0] * si + M[1] * co, cx, M[2] * co + M[3] * si, -M[2] * si + M[3] * co, cy, 0, 0, 1];
    };
    const Rpx = Math.sqrt(2 * l1) * (170 / 145);
    // 3) Drehung über das Rot/Grün-Muster finden (wiederholt sich alle 36°) – mehrere Kandidaten
    const mc = lvl(Rpx / 12);
    const scores = [];
    for (let d = 0; d < 36; d += 1.5) scores.push({ d, f: scoreH(mc, affine((d * Math.PI) / 180)) });
    scores.sort((x, y) => y.f - x.f);
    const cands = [];
    for (const sc of scores) {
      if (cands.every((q) => Math.abs(((sc.d - q.d + 54) % 36) - 18) > 5)) cands.push(sc);
      if (cands.length >= 5) break;
    }
    let best = null;
    for (const cand of cands) {
      const H0 = affine((cand.d * Math.PI) / 180);
      // grobe Vorsuche über Größe und Verschiebung (Perspektive verzerrt die Ellipsen-Schätzung)
      let H = H0, bf = scoreH(mc, H0);
      const st = Rpx / 16;
      for (const k of [0.76, 0.84, 0.92, 1, 1.09, 1.18, 1.28]) for (let iy = -4; iy <= 4; iy++) for (let ix = -4; ix <= 4; ix++) {
        const Hk = [H0[0] * k, H0[1] * k, H0[2] + ix * st, H0[3] * k, H0[4] * k, H0[5] + iy * st, 0, 0, 1];
        const f = scoreH(mc, Hk);
        if (f > bf) { bf = f; H = Hk; }
      }
      for (const Hs of H === H0 ? [H0] : [H0, H]) {
        const r = refine(maps, CAL_DST.map(([x, y]) => applyH(Hs, x, y)), { pyr: lvl, coarse: true });
        if (!best || r.quality > best.quality) best = r;
        if (best.quality > 0.35) break;
      }
      if (best.quality > 0.35) break;
    }
    best.pts = orientUp(best.pts);
    return best;
  }

  // Die 20 liegt woanders: Nutzer tippt auf das richtige Feld -> neu ausrichten
  function reorient(pts, tap) {
    const Hi2b = solveH(pts, CAL_DST), Hb2i = solveH(CAL_DST, pts);
    const [bx, by] = applyH(Hi2b, tap[0], tap[1]);
    let deg = (Math.atan2(bx, -by) * 180) / Math.PI;
    const k = Math.round(deg / 18);
    return CAL_DST.map((_, i) => applyH(Hb2i, ...Board.polar(170, i * 90 + k * 18)));
  }

  // Graubild an die neue Kameralage anpassen (Bildpunkt neu -> Scheibe -> Bildpunkt alt)
  // Hnew_i2b / Hold_b2i arbeiten in normierten Koordinaten (0..1)
  // Liefert das umgerechnete Bild; out.invalid markiert Pixel, die die alte Aufnahme nicht gesehen hat
  function warpGray(src, w, h, Hnew_i2b, Hold_b2i) {
    const out = new Uint8Array(w * h);
    const invalid = new Uint8Array(w * h);
    out.invalid = invalid;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const [bx, by] = applyH(Hnew_i2b, (x + 0.5) / w, (y + 0.5) / h);
      const [u, v] = applyH(Hold_b2i, bx, by);
      let sx = u * w - 0.5, sy = v * h - 0.5;
      if (sx < 2 || sy < 2 || sx > w - 3 || sy > h - 3) invalid[y * w + x] = 1;
      sx = Math.min(w - 1.001, Math.max(0, sx)); sy = Math.min(h - 1.001, Math.max(0, sy));
      const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0, i = y0 * w + x0;
      out[y * w + x] = (src[i] * (1 - fx) + src[i + 1] * fx) * (1 - fy) + (src[i + w] * (1 - fx) + src[i + w + 1] * fx) * fy;
    }
    return out;
  }

  // ---------- Kameraposition aus der Homographie schätzen ----------
  // Hb2i: Scheibe (mm) -> Bild (Pixel), w/h: Bildgröße. Annahme: quadratische Pixel, Bildmitte = optische Achse.
  // Liefert ein Modell, mit dem man 3D-Punkte vor der Scheibe (z.B. das Ende eines Pfeils) ins Bild projizieren kann.
  function cameraFromH(Hb2i, w, h) {
    const S = [1, 0, -w / 2, 0, 1, -h / 2, 0, 0, 1];
    const M = [];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
      let v = 0;
      for (let k = 0; k < 3; k++) v += S[r * 3 + k] * Hb2i[k * 3 + c];
      M.push(v);
    }
    const h1 = [M[0], M[3], M[6]], h2 = [M[1], M[4], M[7]], h3 = [M[2], M[5], M[8]];
    const cands = [];
    const fa = -(h1[0] * h2[0] + h1[1] * h2[1]) / (h1[2] * h2[2]);
    if (Number.isFinite(fa) && fa > 0) cands.push(fa);
    const den = h2[2] ** 2 - h1[2] ** 2;
    const fb = (h1[0] ** 2 + h1[1] ** 2 - h2[0] ** 2 - h2[1] ** 2) / den;
    if (Number.isFinite(fb) && fb > 0 && Math.abs(den) > 1e-14) cands.push(fb);
    const fs = cands.map(Math.sqrt).filter((f) => f > 0.25 * w && f < 6 * w);
    if (!fs.length) return null;
    const f = fs.reduce((a, b) => a + b, 0) / fs.length;
    const kin = (v) => [v[0] / f, v[1] / f, v[2]];
    const n = (v) => Math.hypot(v[0], v[1], v[2]);
    const a1 = kin(h1), a2 = kin(h2), a3 = kin(h3);
    let l = 2 / (n(a1) + n(a2));
    if (a3[2] * l < 0) l = -l; // Scheibe liegt vor der Kamera
    const r1 = a1.map((v) => v * l), r2 = a2.map((v) => v * l), t = a3.map((v) => v * l);
    const r3 = [r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const camZ = -dot(r3, t); // z-Koordinate der Kamera im Scheiben-System
    const front = camZ > 0 ? 1 : -1;
    function project(x, y, z) {
      const P = [0, 1, 2].map((i) => r1[i] * x + r2[i] * y + r3[i] * z + t[i]);
      return [(f * P[0]) / P[2] + w / 2, (f * P[1]) / P[2] + h / 2];
    }
    // Bildrichtung, in die ein Pfeil mit Spitze bei (x,y) aus der Scheibe ragt
    function flightDir(x, y, len = 100) {
      const a = project(x, y, 0), b = project(x, y, front * len);
      return [b[0] - a[0], b[1] - a[1]];
    }
    return { f, project, flightDir, front, camZ: Math.abs(camZ) };
  }

  return { CAL_DST, cameraFromH, solveH, applyH, invertH, colorMaps, blurMaps, scoreH, scorePts, refine, autoFind, orientUp, reorient, warpGray, nelderMead };
});
