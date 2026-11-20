// Pfeilerkennung per Bildvergleich + automatische Scheibenerkennung/Nachführung.
//
// Ablauf pro Wurf:
//  1. Referenzbild der Scheibe merken. Nach einem Wurf (Bild wieder ruhig) mit der Referenz vergleichen:
//     Helligkeit UND Farbe, ausgeglichen um Belichtungs-/Farbschwankungen (blockweise) und um minimale
//     Erschütterungen (1-Pixel-Toleranz).
//  2. Veränderte Stellen zu Pfeilen zusammenfassen (auch wenn Spitze, Barrel und Flight getrennt erscheinen),
//     unplausible Flecken verwerfen (Befestigungen, Kanten, Schatten außerhalb, zu lang/zu breit).
//  3. Pfeilachse robust bestimmen, Richtung aus der Kameraposition ableiten (der Pfeil ragt zur Kamera hin),
//     dann entlang der Achse bis zur echten Spitze weitersuchen (die dünne Spitze ist oft kaum sichtbar).
//  4. Spitze per Homographie in mm auf der Scheibe umrechnen -> Punkte.
// Verrutscht die Kamera, findet BoardFinder die Scheibe über die Farbringe wieder und alles wird nachgezogen.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root.Board || require('./board.js'), root.BoardFinder || require('./boardfinder.js'));
  else root.Detector = factory(root.Board, root.BoardFinder);
})(typeof self !== 'undefined' ? self : this, function (Board, F) {
  const { CAL_DST, solveH, applyH, invertH } = F;
  const MIN_QUALITY = 0.12;   // darunter gilt die Scheibe als "nicht gefunden"
  const SEED_R = 196;         // Pfeile werden nur gesucht, wenn ein Teil innerhalb dieses Radius (mm) liegt
  const GROW_R = 250;         // Flights von Randtreffern dürfen bis hierhin reichen
  const OUTSIDE_R = 180;      // Spitze weiter außen = ignoriert (bzw. Miss mit Auto-Miss); 170–180 = knapp daneben -> Miss

  // ---------- kleine Bildwerkzeuge ----------
  function dilate(bin, w, h) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!bin[y * w + x]) continue;
      const y0 = y > 0 ? y - 1 : 0, y1 = y < h - 1 ? y + 1 : y, x0 = x > 0 ? x - 1 : 0, x1 = x < w - 1 ? x + 1 : x;
      for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) out[yy * w + xx] = 1;
    }
    return out;
  }

  // alle zusammenhängenden Flächen (8er-Nachbarschaft)
  function components(bin, w, h, minSize = 1) {
    const seen = new Uint8Array(w * h);
    const stack = new Int32Array(w * h);
    const out = [];
    for (let s = 0; s < w * h; s++) {
      if (!bin[s] || seen[s]) continue;
      let sp = 0;
      const pix = [];
      stack[sp++] = s; seen[s] = 1;
      while (sp) {
        const p = stack[--sp];
        pix.push(p);
        const x = p % w, y = (p / w) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const q = yy * w + xx;
            if (bin[q] && !seen[q]) { seen[q] = 1; stack[sp++] = q; }
          }
        }
      }
      if (pix.length >= minSize) out.push(pix);
    }
    return out.sort((a, b) => b.length - a.length);
  }
  // Kompatibilität (ältere Tests)
  const largestComponent = (bin, w, h) => components(bin, w, h)[0] || [];

  // Hysterese: Fleck in angrenzende Pixel mit schwächerem Unterschied wachsen lassen
  function grow(seed, weak, w, h, limit, allow) {
    const inSet = new Uint8Array(w * h);
    const out = seed.slice();
    for (const p of seed) inSet[p] = 1;
    for (let k = 0; k < out.length; k++) {
      const p = out[k], x = p % w, y = (p / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = yy * w + xx;
        if (!inSet[q] && weak[q] && (!allow || allow(xx, yy))) { inSet[q] = 1; out.push(q); }
      }
      if (out.length > limit) break; // Notbremse
    }
    return out;
  }

  // Hauptachse (PCA) einer Pixelmenge
  function pca(pix, w) {
    const n = pix.length;
    let mx = 0, my = 0;
    for (const p of pix) { mx += p % w; my += (p / w) | 0; }
    mx /= n; my /= n;
    let cxx = 0, cyy = 0, cxy = 0;
    for (const p of pix) {
      const dx = (p % w) - mx, dy = ((p / w) | 0) - my;
      cxx += dx * dx; cyy += dy * dy; cxy += dx * dy;
    }
    const th = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    const tr = (cxx + cyy) / n, dt = Math.sqrt(Math.max(0, ((cxx - cyy) / n / 2) ** 2 + (cxy / n) ** 2));
    return { mx, my, dir: [Math.cos(th), Math.sin(th)], l1: tr / 2 + dt, l2: Math.max(0, tr / 2 - dt) };
  }

  // Robuste Pfeilachse: Mittelpunkte quer zur Achse in Scheiben (Bins) bestimmen, Gerade hindurchlegen, Ausreißer weg
  function fitAxis(pix, w) {
    const P0 = pca(pix, w);
    let o = [P0.mx, P0.my], d = P0.dir;
    for (let it = 0; it < 3; it++) {
      const bins = new Map();
      for (const p of pix) {
        const x = p % w, y = (p / w) | 0;
        const t = (x - o[0]) * d[0] + (y - o[1]) * d[1], q = -(x - o[0]) * d[1] + (y - o[1]) * d[0];
        const k = Math.round(t / 1.5);
        if (!bins.has(k)) bins.set(k, []);
        bins.get(k).push(q);
      }
      const pts = [];
      for (const [k, qs] of bins) { qs.sort((a, b) => a - b); pts.push([k * 1.5, qs[qs.length >> 1], qs.length]); }
      if (pts.length < 4) break;
      // gewichtete Gerade q = a + b t (schmale Bereiche zählen mehr: dort sitzt die Achse genau)
      let keep = pts;
      for (let r = 0; r < 2; r++) {
        let sw = 0, st = 0, sq = 0, stt = 0, stq = 0;
        for (const [t, q, c] of keep) { const wt = 1 / (1 + c / 6); sw += wt; st += wt * t; sq += wt * q; stt += wt * t * t; stq += wt * t * q; }
        const den = sw * stt - st * st;
        if (Math.abs(den) < 1e-9) break;
        const b = (sw * stq - st * sq) / den, a = (sq - b * st) / sw;
        const next = keep.filter(([t, q]) => Math.abs(q - (a + b * t)) < 2.5);
        if (r === 1 || next.length < 4) {
          // neue Achse
          const ang = Math.atan(b);
          const nd = [d[0] * Math.cos(ang) - d[1] * Math.sin(ang), d[1] * Math.cos(ang) + d[0] * Math.sin(ang)];
          o = [o[0] - d[1] * a, o[1] + d[0] * a];
          d = nd;
          break;
        }
        keep = next;
      }
    }
    return { o, d };
  }

  // Ältere Schnittstelle: Spitze nur aus der Form (wird für Tests/Fallback behalten)
  function findTip(pix, w, mode, expect) {
    const ax = fitAxis(pix, w);
    let tmin = Infinity, tmax = -Infinity;
    for (const p of pix) { const t = ((p % w) - ax.o[0]) * ax.d[0] + (((p / w) | 0) - ax.o[1]) * ax.d[1]; tmin = Math.min(tmin, t); tmax = Math.max(tmax, t); }
    let lowEnd = true;
    if (expect) lowEnd = ax.d[0] * expect[0] + ax.d[1] * expect[1] > 0;
    const t = lowEnd ? tmin : tmax;
    return { x: ax.o[0] + ax.d[0] * t, y: ax.o[1] + ax.d[1] * t, length: tmax - tmin };
  }

  // Gradienten (zentrale Differenzen) eines Kanals
  function gradients(img, w, h) {
    const gx = new Int16Array(w * h), gy = new Int16Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      gx[i] = img[i + 1] - img[i - 1];
      gy[i] = img[i + w] - img[i - w];
    }
    return [gx, gy];
  }

  // Referenzbild: Helligkeit + Farbanteile (u: rot-grün, v: blau-grün) samt Kantenstärke.
  // Kantenstärke = wie stark sich ein Pixel bei einer winzigen Restverschiebung ändern darf.
  function makeRef(img, w, h, _tolerant, chroma) {
    const R = { img };
    [R.gx, R.gy] = gradients(img, w, h); // doppelte Steigung (zentrale Differenz)
    if (chroma && chroma.u) {
      R.u = chroma.u; R.v = chroma.v;
      const [ux, uy] = gradients(chroma.u, w, h), [vx, vy] = gradients(chroma.v, w, h);
      const gc = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) gc[i] = Math.min(255, (Math.abs(ux[i]) + Math.abs(uy[i]) + Math.abs(vx[i]) + Math.abs(vy[i])) >> 1);
      R.gc = gc;
    }
    return R;
  }

  // 6x6-Gleichungssystem (Gauß mit Pivotsuche)
  function solve6(A, b) {
    const n = 6, M = [];
    for (let r = 0; r < n; r++) { M.push([]); for (let c = 0; c < n; c++) M[r].push(A[r * n + c]); M[r].push(b[r]); }
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      if (Math.abs(M[piv][c]) < 1e-9) return null;
      [M[c], M[piv]] = [M[piv], M[c]];
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map((row, i) => row[n] / row[i]);
  }

  function median(arr, n) {
    const a = arr.subarray(0, n);
    a.sort();
    return n ? a[n >> 1] : 0;
  }

  // ---------- Detektor (Browser) ----------
  class DartDetector {
    constructor(cb = {}) {
      this.cb = cb;
      this.procW = 1280;       // höchste Auswerte-Breite (wird an Kamera und Handy-Leistung angepasst)
      this.minProcW = 720;
      this.threshold = 28;     // Helligkeitsunterschied pro Pixel
      this.tipMode = 'auto';   // auto | lowest | highest
      this.autoMiss = false;   // Pfeile außerhalb der Scheibe automatisch als "Miss" zählen
      this.phase = 'idle';     // idle | throw | pull
      this.autoTrack = true;   // Kamera-Verrutschen automatisch ausgleichen
      this.trackEvery = 25;    // alle ~2,5 s ruhiges Bild prüfen
      this.H = null; this.Hinv = null; this.calib = null;
      this.w = 0; this.h = 0;
      this.running = false;
      this.stable = 0; this.evaluated = true;
      this.quality = null; this.lost = false;
      this.view = { x: 0, y: 0, w: 1, h: 1 }; // Bildausschnitt (digitaler Zoom), normiert aufs Kamerabild
      this.hz = 1;                             // Hardware-Zoom der Kamera
      this.lastDebug = null;
      if (typeof document !== 'undefined') {
        this.canvas = document.createElement('canvas');
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      }
    }

    // keepRefs: Referenzbilder an die neue Lage anpassen statt verwerfen (beim Nachführen)
    setCalibration(pts, keepRefs) {
      const oldHinv = this.Hinv;
      this.calib = pts;
      this.H = pts ? solveH(pts, CAL_DST) : null;
      this.Hinv = this.H ? invertH(this.H) : null;
      this.mask = null;
      if (keepRefs && oldHinv && this.H && this.ref && this.w) {
        const warp = (R) => {
          const wp = (a) => F.warpGray(a, this.w, this.h, this.H, oldHinv);
          const img = wp(R.img);
          const ref = makeRef(img, this.w, this.h, true, R.u ? { u: wp(R.u), v: wp(R.v) } : null);
          ref.invalid = img.invalid; // diese Pixel hat die alte Aufnahme nicht gesehen -> nicht vergleichen
          ref.warped = true;
          return ref;
        };
        const same = this.emptyRef === this.ref;
        this.ref = warp(this.ref);
        this.emptyRef = same ? this.ref : this.emptyRef && warp(this.emptyRef);
        this.buildExclusion(oldHinv);
      } else {
        this.ref = null;
        this.emptyRef = null;
      }
      if (this.w && this.H) this.buildMask();
    }

    // Kalibrierung um (dx, dy) Pixel verschieben (gemessene Erschütterung). Referenzbilder bleiben, wie sie sind:
    // der Bildvergleich misst die Verschiebung jedes Mal selbst und rechnet sie heraus.
    shiftCalibration(P) {
      if (!this.calib) return;
      // ein Scheibenpunkt, der in der Referenz bei q lag, liegt jetzt bei q - Bewegung(q)
      this.calib = this.calib.map(([u, v]) => {
        const [mx, my] = this.motionAt(P, u * this.w, v * this.h);
        return [u - mx / this.w, v - my / this.h];
      });
      this.H = solveH(this.calib, CAL_DST);
      this.Hinv = invertH(this.H);
      this.buildMask();
      this.cb.onShift && this.cb.onShift({ calib: this.calib });
    }

    // Bereiche der schon gezählten Pfeile in die neue Kameralage übertragen. Sie werden nach einem
    // Verrutschen ignoriert, weil die aus der Scheibe ragenden Pfeile nicht exakt umzurechnen sind.
    buildExclusion(oldHinv) {
      const { w, h } = this;
      if (!this.turnBlobs || !this.turnBlobs.length) { this.exclude = null; return; }
      const oldH = invertH(oldHinv);
      let ex = new Uint8Array(w * h);
      for (const blob of this.turnBlobs) for (const p of blob) {
        const [bx, by] = applyH(oldH, ((p % w) + 0.5) / w, (((p / w) | 0) + 0.5) / h);
        const [u, v] = applyH(this.Hinv, bx, by);
        const x = Math.round(u * w - 0.5), y = Math.round(v * h - 0.5);
        if (x >= 0 && y >= 0 && x < w && y < h) ex[y * w + x] = 1;
      }
      for (let k = 0; k < 4; k++) ex = dilate(ex, w, h);
      this.exclude = ex;
      this.turnBlobs = this.turnBlobs.map(() => []); // alte Positionen verfallen, Bereiche stehen in exclude
    }

    // Zoom/Ausschnitt ändern. Die Kalibrierung wird mit umgerechnet (Hardware-Zoom = Skalierung um die Bildmitte).
    setView(view, hz = this.hz) {
      const ov = this.view, oh = this.hz;
      this.view = view;
      this.hz = hz;
      if (!this.calib) return;
      const conv = ([u, v]) => {
        const fx = ov.x + u * ov.w, fy = ov.y + v * ov.h;          // im alten Kamerabild
        const gx = 0.5 + (fx - 0.5) / oh, gy = 0.5 + (fy - 0.5) / oh; // ohne Hardware-Zoom
        const hx = 0.5 + (gx - 0.5) * hz, hy = 0.5 + (gy - 0.5) * hz; // im neuen Kamerabild
        return [(hx - view.x) / view.w, (hy - view.y) / view.h];
      };
      this.setCalibration(this.calib.map(conv), true);
      this.prev = null; this.prevSm = null; // nächstes Bild: Lage über die Farbringe prüfen
      this.freshAfterView = true; // und Referenz in der neuen Schärfe aufnehmen
    }

    toBoard(u, v) { return this.H ? applyH(this.H, u, v) : null; }
    toImage(x, y) { return this.Hinv ? applyH(this.Hinv, x, y) : null; }

    start(video) {
      this.video = video;
      if (this.running) return;
      this.running = true;
      const loop = () => {
        if (!this.running) return;
        try { this.tick(); } catch (e) { console.error(e); }
        this.timer = setTimeout(loop, 90);
      };
      loop();
    }

    stop() { this.running = false; clearTimeout(this.timer); this.ref = null; this.emptyRef = null; this.prev = null; this.prevSm = null; }

    ensureSize() {
      const v = this.video;
      if (!v || !v.videoWidth) return false;
      // nicht feiner als das Kamerabild selbst (Hochskalieren bringt nichts), nicht gröber als minProcW
      const native = Math.round(v.videoWidth * this.view.w);
      const w = Math.max(Math.min(this.minProcW, native), Math.min(this.procW, native) & ~7);
      const h = Math.round((w * v.videoHeight * this.view.h) / (v.videoWidth * this.view.w));
      if (w !== this.w || h !== this.h) {
        this.w = w; this.h = h;
        this.canvas.width = w; this.canvas.height = h;
        this.cur = new Uint8Array(w * h);
        this.tmp = new Uint8Array(w * h);
        this.cu = new Uint8Array(w * h); this.cv = new Uint8Array(w * h);
        this.prev = null; this.prevSm = null; this.ref = null; this.emptyRef = null; this.mask = null; this.avgY = null;
      }
      return true;
    }

    buildMask() {
      const { w, h } = this;
      this.mask = new Uint8Array(w * h);  // 1 = Pfeil darf hier beginnen, 2 = nur Wachsen erlaubt
      this.radius = new Uint8Array(w * h); // Abstand zum Bull in 2-mm-Schritten (für schnelle Abfragen)
      let n = 0, inner = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const [bx, by] = applyH(this.H, (x + 0.5) / w, (y + 0.5) / h);
        const r = Math.hypot(bx, by), i = y * w + x;
        this.radius[i] = Math.min(255, r / 2);
        if (r < SEED_R) { this.mask[i] = 1; n++; }
        else if (r < GROW_R) this.mask[i] = 2;
        if (r < 182) inner++;
      }
      this.boardPx = Math.max(inner, 1);
      this.maskPx = Math.max(n, 1);
      // Kamera-Modell (Scheibe mm -> Bild Pixel), um die Pfeilrichtung vorherzusagen.
      // Optische Achse = Mitte des vollen Kamerabildes (bei Zoom-Ausschnitt nicht die Mitte des Ausschnitts).
      const S = [w, 0, 0, 0, h, 0, 0, 0, 1], Hn = this.Hinv, Hpx = [];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) { let v = 0; for (let k = 0; k < 3; k++) v += S[r * 3 + k] * Hn[k * 3 + c]; Hpx.push(v); }
      const vw = this.view;
      const pp = [((0.5 - vw.x) / vw.w) * w, ((0.5 - vw.y) / vw.h) * h];
      const fGuess = (0.72 * this.hz * w) / vw.w; // typische Handy-Hauptkamera (~70° Bildwinkel)
      this.cam = F.cameraFromH(Hpx, w, h, pp, fGuess);
    }

    // Wie gut kann diese Kameraposition messen? Pixel pro mm an der ungünstigsten Stelle der Scheibe
    // (in der am stärksten gestauchten Richtung) und Blickwinkel zur Scheibe.
    qualityInfo() {
      if (!this.Hinv || !this.w) return null;
      const { w, h } = this;
      let worst = Infinity;
      for (let r = 0; r <= 170; r += 34) for (let a = 0; a < 360; a += r ? 30 : 360) {
        const [bx, by] = Board.polar(r, a);
        const p = applyH(this.Hinv, bx, by), px = applyH(this.Hinv, bx + 1, by), py = applyH(this.Hinv, bx, by + 1);
        const J = [(px[0] - p[0]) * w, (py[0] - p[0]) * w, (px[1] - p[1]) * h, (py[1] - p[1]) * h];
        // kleinster Singulärwert der 2x2-Jacobi-Matrix = Pixel pro mm in der schlechtesten Richtung
        const a2 = J[0] * J[0] + J[2] * J[2], b2 = J[0] * J[1] + J[2] * J[3], c2 = J[1] * J[1] + J[3] * J[3];
        const sMin = Math.sqrt(Math.max(0, (a2 + c2) / 2 - Math.sqrt(((a2 - c2) / 2) ** 2 + b2 * b2)));
        worst = Math.min(worst, sMin);
      }
      let angle = null, dist = null;
      if (this.cam && this.cam.center) {
        const [cx, cy, cz] = this.cam.center;
        dist = Math.hypot(cx, cy, cz);
        angle = Math.round((Math.acos(Math.min(1, Math.abs(cz) / dist)) * 180) / Math.PI); // 0° = frontal
      }
      const level = worst >= 0.9 ? 3 : worst >= 0.6 ? 2 : worst >= 0.4 ? 1 : 0;
      return { pxPerMm: worst, mmPerPx: 1 / worst, angle, dist, level };
    }

    // Pixel pro mm an einer Bildstelle (Pixel-Koordinaten)
    scaleAt(x, y) {
      const { w, h } = this;
      const [bx, by] = applyH(this.H, (x + 0.5) / w, (y + 0.5) / h);
      const a = applyH(this.Hinv, bx + 1, by), b = applyH(this.Hinv, bx, by + 1);
      return (Math.hypot(a[0] * w - x - 0.5, a[1] * h - y - 0.5) + Math.hypot(b[0] * w - x - 0.5, b[1] * h - y - 0.5)) / 2;
    }

    grab() {
      const { w, h, ctx } = this, v = this.video, c = this.view;
      const vw = v.videoWidth, vh = v.videoHeight;
      ctx.drawImage(v, c.x * vw, c.y * vh, c.w * vw, c.h * vh, 0, 0, w, h);
      this.rgba = ctx.getImageData(0, 0, w, h).data;
      this.grayStale = true; // Graubild wird nur bei Bedarf (ruhiges Bild) berechnet
    }

    ensureGray() { if (this.grayStale && this.rgba) this.toGray(this.rgba); }

    // halbe Auflösung, nur Helligkeit: für die schnelle Bewegungserkennung bei jedem Bild
    makeSmall() {
      const { w, h, rgba: d } = this;
      const w2 = w >> 1, h2 = h >> 1;
      if (!this.sm || this.sm.length !== w2 * h2) { this.sm = new Uint8Array(w2 * h2); this.prevSm = null; }
      const sm = this.sm;
      for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
        const j = ((2 * y) * w + 2 * x) * 4, k = j + 4 * w + 4;
        sm[y * w2 + x] = ((d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) + (d[k] * 77 + d[k + 1] * 150 + d[k + 2] * 29)) >> 9;
      }
    }

    motionSmall() {
      const { w, h, mask, sm, prevSm } = this, T = this.threshold;
      const w2 = w >> 1, h2 = h >> 1;
      let c = 0;
      for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
        if (mask[(2 * y) * w + 2 * x] !== 1) continue;
        const i = y * w2 + x;
        const dd = sm[i] - prevSm[i];
        if (dd > T || dd < -T) c++;
      }
      return c * 4; // auf volle Auflösung hochgerechnet
    }

    toGray(d) {
      const { w, h } = this;
      const n = w * h;
      if (!this.cu || this.cu.length !== n) { this.cu = new Uint8Array(n); this.cv = new Uint8Array(n); }
      if (!this.tmp || this.tmp.length !== n) this.tmp = new Uint8Array(n);
      if (!this.cur || this.cur.length !== n) this.cur = new Uint8Array(n);
      const g = this.tmp;
      const u0 = this.u0 && this.u0.length === n ? this.u0 : (this.u0 = new Uint8Array(n));
      const v0 = this.v0 && this.v0.length === n ? this.v0 : (this.v0 = new Uint8Array(n));
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
        u0[i] = ((d[j] - d[j + 1]) >> 1) + 128;     // rot-grün
        v0[i] = ((d[j + 2] - d[j + 1]) >> 1) + 128; // blau-grün
      }
      // leichter 1-2-1-Weichzeichner gegen Rauschen (dünne Spitzen bleiben erhalten)
      this.blur121(g, this.cur);
      this.blur121(u0, this.cu);
      this.blur121(v0, this.cv);
      this.grayStale = false;
    }

    blur121(src, out) {
      const { w, h } = this;
      const t = this.blurTmp && this.blurTmp.length === w * h ? this.blurTmp : (this.blurTmp = new Uint16Array(w * h));
      for (let y = 0; y < h; y++) {
        const o = y * w;
        for (let x = 0; x < w; x++) t[o + x] = src[o + (x > 0 ? x - 1 : x)] + 2 * src[o + x] + src[o + (x < w - 1 ? x + 1 : x)];
      }
      for (let y = 0; y < h; y++) {
        const ou = (y > 0 ? y - 1 : y) * w, o = y * w, od = (y < h - 1 ? y + 1 : y) * w;
        for (let x = 0; x < w; x++) out[o + x] = (t[ou + x] + 2 * t[o + x] + t[od + x] + 8) >> 4;
      }
    }

    // Belichtung/Farbe blockweise ausgleichen: pro Block Median von Helligkeits-Verhältnis und Farbverschiebung
    normalizer(a, R) {
      const { w, h, mask } = this;
      const BX = 8, BY = Math.max(3, Math.round((8 * h) / w));
      const bw = w / BX, bh = h / BY;
      const useC = !!(R.u && this.cu && a === this.cur);
      const gain = new Float32Array(BX * BY), uo = new Float32Array(BX * BY), vo = new Float32Array(BX * BY);
      const bufG = new Float32Array(Math.ceil(bw / 2 + 1) * Math.ceil(bh / 2 + 1) + 8);
      const bufU = new Float32Array(bufG.length), bufV = new Float32Array(bufG.length);
      const allG = [], allU = [], allV = [];
      const ok = new Uint8Array(BX * BY);
      for (let by = 0; by < BY; by++) for (let bx = 0; bx < BX; bx++) {
        let k = 0;
        const x0 = Math.floor(bx * bw), x1 = Math.floor((bx + 1) * bw), y0 = Math.floor(by * bh), y1 = Math.floor((by + 1) * bh);
        for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
          const i = y * w + x;
          if (!mask[i]) continue;
          const gr = (a[i] + 8) / (R.img[i] + 8);
          // nur kleine Änderungen zählen (Belichtung/Farbstich); Pfeile/Flights würden die Korrektur verfälschen
          if (gr < 0.8 || gr > 1.25) continue;
          if (useC) {
            const du = this.cu[i] - R.u[i], dv = this.cv[i] - R.v[i];
            if (du > 14 || du < -14 || dv > 14 || dv < -14) continue;
            bufU[k] = du; bufV[k] = dv;
          }
          bufG[k] = gr;
          k++;
        }
        const bi = by * BX + bx;
        if (k >= 40) {
          ok[bi] = 1;
          gain[bi] = median(bufG, k); allG.push(gain[bi]);
          if (useC) { uo[bi] = median(bufU, k); vo[bi] = median(bufV, k); allU.push(uo[bi]); allV.push(vo[bi]); }
        }
      }
      const med = (arr, d) => { if (!arr.length) return d; arr.sort((x, y) => x - y); return arr[arr.length >> 1]; };
      const gG = med(allG, 1), gU = med(allU, 0), gV = med(allV, 0);
      for (let i = 0; i < BX * BY; i++) if (!ok[i]) { gain[i] = gG; uo[i] = gU; vo[i] = gV; }
      // bilinear interpoliert abfragen
      return {
        useC,
        at(x, y) {
          let fx = x / bw - 0.5, fy = y / bh - 0.5;
          fx = Math.max(0, Math.min(BX - 1.001, fx)); fy = Math.max(0, Math.min(BY - 1.001, fy));
          const ix = fx | 0, iy = fy | 0, ax = fx - ix, ay = fy - iy;
          const i00 = iy * BX + ix, i10 = i00 + 1, i01 = i00 + BX, i11 = i01 + 1;
          const L = (arr) => (arr[i00] * (1 - ax) + arr[i10] * ax) * (1 - ay) + (arr[i01] * (1 - ax) + arr[i11] * ax) * ay;
          return [L(gain), L(uo), L(vo)];
        },
      };
    }

    // Misst die (Sub-Pixel-)Bewegung zwischen Referenz und aktuellem Bild (Erschütterung beim Einschlag):
    // affin (Verschiebung + leichte Drehung/Skalierung), Lucas-Kanade über die ganze Scheibe.
    // Ergebnis p: Verschiebung an (x,y) = [p0 + p1*X + p2*Y, p3 + p4*X + p5*Y] mit X=(x-w/2)/w, Y=(y-h/2)/w.
    // Pixel mit großem Unterschied (Pfeile) zählen nicht mit.
    estimateMotion(a, R, N) {
      const { w, h, mask } = this, img = R.img, gx = R.gx, gy = R.gy;
      const p = [0, 0, 0, 0, 0, 0];
      const J = new Float64Array(6);
      for (let it = 0; it < 6; it++) {
        const A = new Float64Array(36), b = new Float64Array(6);
        for (let y0 = 8; y0 < h - 8; y0 += 8) for (let x0 = 8; x0 < w - 8; x0 += 8) {
          const X = (x0 + 4 - w / 2) / w, Y = (y0 + 4 - h / 2) / w;
          const dx = p[0] + p[1] * X + p[2] * Y, dy = p[3] + p[4] * X + p[5] * Y;
          const ix = Math.floor(dx), iy = Math.floor(dy), fx = dx - ix, fy = dy - iy, off = iy * w + ix;
          const [g] = N.at(x0 + 4, y0 + 4);
          for (let y = y0; y < y0 + 8; y += 2) for (let x = x0; x < x0 + 8; x += 2) {
            const i = y * w + x;
            if (!mask[i] || (R.invalid && R.invalid[i])) continue;
            const ex = gx[i], ey = gy[i];
            if (ex === 0 && ey === 0) continue;
            const j = i + off;
            if (j < w || j >= w * h - w - 1) continue;
            const rv = (img[j] * (1 - fx) + img[j + 1] * fx) * (1 - fy) + (img[j + w] * (1 - fx) + img[j + w + 1] * fx) * fy;
            const e = a[i] - ((rv + 8) * g - 8);
            if (e > 30 || e < -30) continue; // Pfeil o. ä.
            const Ix = 0.5 * ex * g, Iy = 0.5 * ey * g;
            const Xp = (x - w / 2) / w, Yp = (y - h / 2) / w;
            J[0] = Ix; J[1] = Ix * Xp; J[2] = Ix * Yp; J[3] = Iy; J[4] = Iy * Xp; J[5] = Iy * Yp;
            for (let r = 0; r < 6; r++) { b[r] += J[r] * e; for (let c = r; c < 6; c++) A[r * 6 + c] += J[r] * J[c]; }
          }
        }
        for (let r = 0; r < 6; r++) for (let c = 0; c < r; c++) A[r * 6 + c] = A[c * 6 + r];
        for (let r = 0; r < 6; r++) A[r * 6 + r] *= 1.0001; // leichte Dämpfung
        const d = solve6(A, b);
        if (!d) break;
        for (let k = 0; k < 6; k++) p[k] += d[k];
        if (Math.abs(p[0]) > 4 || Math.abs(p[3]) > 4) break;
        if (Math.abs(d[0]) + Math.abs(d[3]) + 0.5 * (Math.abs(d[1]) + Math.abs(d[2]) + Math.abs(d[4]) + Math.abs(d[5])) < 0.02) break;
      }
      return p;
    }

    // Bewegung an einer Bildstelle
    motionAt(p, x, y) {
      const X = (x - this.w / 2) / this.w, Y = (y - this.h / 2) / this.w;
      return [p[0] + p[1] * X + p[2] * Y, p[3] + p[4] * X + p[5] * Y];
    }

    // Vergleicher für ein Bild gegen eine Referenz: Belichtung/Farbe ausgeglichen, Erschütterung herausgerechnet.
    // Vor der Abfrage eines Pixels: at(x, y) für dessen Block; pixel(i, x, y) -> [Helligkeits-, Farbabweichung]
    comparator(a, R) {
      const { w, h } = this;
      const N = this.normalizer(a, R);
      const P = this.estimateMotion(a, R, N);
      const self = this, mask = this.mask;
      const img = R.img, gx = R.gx, gy = R.gy, ru = R.u, rv = R.v, gc = R.gc, inv = R.invalid;
      const useC = N.useC, cu = this.cu, cv = this.cv;
      // Rest-Unschärfe (Pixel): frische Referenz sehr genau; auf neue Kameralage umgerechnete Referenz ungenauer
      const BAND = R.warped ? 1.0 : 0.3;
      let off = 0, k00 = 1, k10 = 0, k01 = 0, k11 = 0, g = 1, uo = 0, vo = 0, bx = -1, by = -1;
      const [cdx, cdy] = this.motionAt(P, w / 2, h / 2);
      return {
        N, P, dx: cdx, dy: cdy,
        // Parameter für den 8x8-Block um (x, y) setzen
        at(x, y) {
          const nbx = x >> 3, nby = y >> 3;
          if (nbx === bx && nby === by) return;
          bx = nbx; by = nby;
          const cx = (nbx << 3) + 4, cy = (nby << 3) + 4;
          const [dx, dy] = self.motionAt(P, cx, cy);
          const ix = Math.floor(dx), iy = Math.floor(dy), fx = dx - ix, fy = dy - iy;
          off = iy * w + ix;
          k00 = (1 - fx) * (1 - fy); k10 = fx * (1 - fy); k01 = (1 - fx) * fy; k11 = fx * fy;
          [g, uo, vo] = N.at(cx, cy);
        },
        pixel(i) {
          if (inv && inv[i]) return null;
          const j = i + off;
          if (j < 0 || j >= w * h - w - 1) return null;
          const r = img[j] * k00 + img[j + 1] * k10 + img[j + w] * k01 + img[j + w + 1] * k11;
          const band = mask[i] === 2 ? BAND * 2 : BAND; // Rand (Zahlenring, Halterungen): Bewegung dort ungenauer
          const tol = band * 0.5 * (Math.abs(gx[i]) + Math.abs(gy[i])) * g;
          let d = Math.abs(a[i] - ((r + 8) * g - 8)) - tol;
          if (d < 0) d = 0;
          let c = 0;
          if (useC) {
            const ur = ru[j] * k00 + ru[j + 1] * k10 + ru[j + w] * k01 + ru[j + w + 1] * k11;
            const vr = rv[j] * k00 + rv[j + 1] * k10 + rv[j + w] * k01 + rv[j + w + 1] * k11;
            c = Math.abs(cu[i] - uo - ur) + Math.abs(cv[i] - vo - vr) - band * gc[i];
            if (c < 0) c = 0;
          }
          return [d, c];
        },
      };
    }

    // Unterschied Bild <-> Referenz.
    // bin  = deutlicher Unterschied (hier darf ein Pfeil beginnen)
    // weak = schwacher Unterschied (zum Wachsen bis in die dünne Spitze)
    diff(a, R, wantMask) {
      const { mask, w, h } = this;
      const T = this.threshold, TC = T * 0.75, TW = T * 0.5, TCW = TC * 0.55;
      const C = this.comparator(a, R);
      const bin = wantMask ? new Uint8Array(w * h) : null;
      const weak = wantMask ? new Uint8Array(w * h) : null;
      let count = 0;
      const BS = 8; // Normierung blockweise vorberechnen (8x8 Pixel)
      for (let y0 = 0; y0 < h; y0 += BS) for (let x0 = 0; x0 < w; x0 += BS) {
        C.at(x0, y0);
        const y1 = Math.min(h, y0 + BS), x1 = Math.min(w, x0 + BS);
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          const i = y * w + x;
          if (!mask[i]) continue;
          const p = C.pixel(i);
          if (!p) continue;
          const [dy, dc] = p;
          if (dy > T || dc > TC) { count++; if (bin) bin[i] = 1; }
          if (weak && (dy > TW || dc > TCW)) weak[i] = 1;
        }
      }
      if (wantMask && this.exclude) {
        for (let i = 0; i < w * h; i++) if (this.exclude[i] && bin[i]) { bin[i] = 0; count--; }
      }
      return { count, bin, weak, N: C.N, C };
    }

    // einfacher Bewegungsvergleich zum vorigen Bild
    motion(a, b) {
      const { mask, w, h } = this, T = this.threshold;
      let c = 0;
      for (let i = 0; i < w * h; i++) if (mask[i] === 1 && Math.abs(a[i] - b[i]) > T) c++;
      return c;
    }

    snapRef() { return this.cur ? makeRef(this.cur.slice(), this.w, this.h, false, this.cu && this.rgba ? { u: this.cu.slice(), v: this.cv.slice() } : null) : null; }

    // Neue Aufnahme beginnen (Scheibe leer)
    // Wird "Weiter" gedrückt, bevor die Pfeile gezogen sind, stecken sie noch in der Scheibe. Dann bleibt das
    // letzte Bild der LEEREN Scheibe gültig und die Erkennung wartet (ohne neue Würfe zu verpassen) aufs Ziehen.
    startTurn() {
      this.turnDarts = 0;
      this.turnBlobs = [];
      this.exclude = null;
      this.evaluated = true;
      this.phase = 'throw';
      if (!this.cur || !this.mask || !this.H) { this.ref = this.snapRef(); this.emptyRef = this.ref; this.awaitClear = false; return; }
      this.ensureGray();
      const dirty = this.emptyRef && this.diff(this.cur, this.emptyRef, false).count > this.minPx() * 3;
      this.ref = this.snapRef();
      if (dirty) { this.awaitClear = true; this.status('Pfeile ziehen …'); }
      else { this.emptyRef = this.ref; this.awaitClear = false; }
    }

    // Aktuellen Zustand als Referenz übernehmen (z. B. nach manueller Eingabe)
    rebaseline() {
      this.turnDarts = (this.turnDarts || 0) + 1; // manuell eingetragener Pfeil steckt evtl. in der Scheibe
      this.ref = this.snapRef();
      this.evaluated = true;
    }

    // ---------- Scheibe finden / nachführen ----------
    autoCalibrate() {
      if (!this.rgba || !this.w) return null;
      const r = F.autoFind(this.rgba, this.w, this.h);
      if (!r || r.quality < MIN_QUALITY) return null;
      return { pts: r.pts.map(([x, y]) => [x / this.w, y / this.h]), quality: r.quality };
    }

    refineCalibration(ptsNorm) {
      if (!this.rgba || !this.w) return null;
      const maps = F.colorMaps(this.rgba, this.w, this.h);
      const r = F.refine(maps, ptsNorm.map(([u, v]) => [u * this.w, v * this.h]), { search: 8 });
      return { pts: r.pts.map(([x, y]) => [x / this.w, y / this.h]), quality: r.quality };
    }

    // Prüft die Lage der Scheibe und passt die Kalibrierung an, wenn die Kamera verrutscht ist
    // fresh: Scheibe war ruhig und ausgewertet -> danach Referenz frisch übernehmen
    realign(search, fresh) {
      if (!this.rgba || !this.calib || !this.w) return null;
      this.ensureGray();
      const { w, h } = this;
      const old = this.calib.map(([u, v]) => [u * w, v * h]);
      const maps = F.colorMaps(this.rgba, w, h);
      const r = F.refine(maps, old, { search });
      this.quality = r.quality;
      if (r.quality < MIN_QUALITY) {
        if (!this.lost) { this.lost = true; this.status('Scheibe nicht gefunden – Kamera prüfen'); this.cb.onLost && this.cb.onLost(); }
        return { lost: true };
      }
      const moved = Math.max(...r.pts.map((p, i) => Math.hypot(p[0] - old[i][0], p[1] - old[i][1])));
      const wasLost = this.lost;
      this.lost = false;
      if (moved > 0.8 && r.quality > r.startScore + 0.01) {
        this.setCalibration(r.pts.map(([x, y]) => [x / w, y / h]), !wasLost);
        if (wasLost || !this.ref) { this.ref = this.snapRef(); this.emptyRef = this.ref; }
        // Hat sich auf der Scheibe nichts geändert, Referenz gleich frisch übernehmen (exakter als umgerechnet)
        else if (fresh || this.diff(this.cur, this.ref, false).count < this.minPx()) {
          const same = this.emptyRef === this.ref;
          this.ref = this.snapRef();
          if (same) this.emptyRef = this.ref;
          this.exclude = null;
        }
        this.prevSm = this.sm ? this.sm.slice() : null;
        this.cb.onRealign && this.cb.onRealign({ moved, quality: r.quality, calib: this.calib });
        return { moved };
      }
      if (wasLost) { this.ref = this.snapRef(); this.emptyRef = this.ref; this.cb.onRealign && this.cb.onRealign({ moved: 0, quality: r.quality, calib: this.calib }); }
      return { moved: 0 };
    }

    minPx() { return Math.max(20, this.boardPx * 0.0005); }

    tick() {
      if (!this.ensureSize()) return;
      const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
      this.grab();
      if (!this.H) return;
      if (!this.mask) this.buildMask();
      this.makeSmall();
      if (!this.prevSm) {
        this.prevSm = this.sm.slice();
        this.ensureGray();
        if (this.autoTrack) this.realign(40); // Lage seit dem letzten Mal geprüft
        if (this.freshAfterView) {
          this.freshAfterView = false;
          const noDarts = !this.turnDarts;
          this.ref = this.snapRef();
          if (noDarts || !this.emptyRef) this.emptyRef = this.ref;
          this.exclude = null;
        }
        if (!this.ref) { this.ref = this.snapRef(); this.emptyRef = this.ref; }
        return;
      }
      if (!this.ref) { this.ensureGray(); this.ref = this.snapRef(); this.emptyRef = this.ref; }
      const motion = this.motionSmall();
      this.prevSm.set(this.sm);
      if (motion > Math.max(40, this.boardPx * 0.0015)) {
        this.stable = 0;
        this.avgN = 0;
        this.evaluated = false;
        this.status('Bewegung …');
        this.perf(t0);
        return;
      }
      this.stable++;
      // Graubild + Mittelung nur, wenn bald ausgewertet wird (spart Rechenzeit)
      const phase8 = this.stable % 8;
      if (!this.evaluated || phase8 >= 5 || phase8 === 0) {
        if (this.evaluated && phase8 === 5) this.avgN = 0;
        this.ensureGray();
        this.accumulate();
      }
      if (this.stable < 4) { this.perf(t0); return; }
      if (!this.evaluated) { this.evaluated = true; this.useAverage(); this.evaluate(); this.perf(t0); return; }
      if (this.lost && this.stable % 10 === 0) { this.realign(60); return; }
      if (this.autoTrack && this.stable % this.trackEvery === 0) { this.realign(12, true); return; }
      // zur Sicherheit regelmäßig nachsehen, falls ein Pfeil ohne erkannte Bewegung dazugekommen ist
      if (phase8 === 0) { this.useAverage(); this.evaluate(); }
      this.perf(t0);
    }

    // Rechenzeit beobachten: ist das Handy zu langsam, Auflösung schrittweise senken
    perf(t0) {
      if (typeof performance === 'undefined' || !this.video) return;
      const dt = performance.now() - t0;
      this.tickMs = this.tickMs == null ? dt : this.tickMs * 0.95 + dt * 0.05;
      this.perfN = (this.perfN || 0) + 1;
      if (this.perfN > 40 && this.tickMs > 75 && this.procW > this.minProcW && !this.turnDarts) {
        this.procW = Math.max(this.minProcW, Math.round((this.w * 0.8) / 8) * 8);
        this.perfN = 0; this.tickMs = null;
        this.cb.onResolution && this.cb.onResolution(this.procW);
      }
    }

    // Ruhige Bilder mitteln (gleitend über ~6 Bilder): weniger Rauschen -> dünne Spitze klarer, Sub-Pixel genauer
    accumulate() {
      const n = this.w * this.h;
      if (!this.avgY || this.avgY.length !== n) { this.avgY = new Float32Array(n); this.avgU = new Float32Array(n); this.avgV = new Float32Array(n); this.avgN = 0; }
      const k = 1 / Math.min(6, (this.avgN || 0) + 1);
      const Y = this.avgY, U = this.avgU, V = this.avgV, a = this.cur, u = this.cu, v = this.cv;
      if (!this.avgN) { for (let i = 0; i < n; i++) { Y[i] = a[i]; U[i] = u[i]; V[i] = v[i]; } }
      else for (let i = 0; i < n; i++) { Y[i] += (a[i] - Y[i]) * k; U[i] += (u[i] - U[i]) * k; V[i] += (v[i] - V[i]) * k; }
      this.avgN = (this.avgN || 0) + 1;
    }

    useAverage() {
      if (this.averaging === false || !this.avgN || this.avgN < 2 || !this.avgY || this.avgY.length !== this.cur.length) return;
      const n = this.cur.length, Y = this.avgY, U = this.avgU, V = this.avgV, a = this.cur, u = this.cu, v = this.cv;
      for (let i = 0; i < n; i++) { a[i] = Y[i] + 0.5; u[i] = U[i] + 0.5; v[i] = V[i] + 0.5; }
    }

    status(s) {
      if (s !== this.lastStatus) { this.lastStatus = s; this.cb.onStatus && this.cb.onStatus(s); }
    }

    // Verrutschte Kamera: viele Änderungen genau auf Kanten der Referenz, verteilt über die ganze Scheibe
    slipLikely(d) {
      const { w, h } = this, R = this.ref.img, bin = d.bin;
      let n = 0, edge = 0;
      const regions = new Set();
      for (let y = 1; y < h - 1; y += 1) for (let x = 1; x < w - 1; x += 1) {
        const i = y * w + x;
        if (!bin[i]) continue;
        n++;
        if (Math.abs(R[i + 1] - R[i - 1]) + Math.abs(R[i + w] - R[i - w]) > 50) edge++;
        regions.add(((x * 4) / w | 0) + 4 * ((y * 4) / h | 0));
      }
      // ein Pfeil betrifft 1–3 Bildregionen; Verrutschen erzeugt Kantenänderungen fast überall
      return n > 0 && ((regions.size >= 6 && edge > 0.3 * n) || (regions.size >= 4 && edge > 0.55 * n));
    }

    // ---------- Pfeile aus dem Unterschiedsbild ----------
    // Fasst Flecken zusammen, die auf einer gemeinsamen Linie liegen (Spitze, Barrel, Flight erscheinen oft getrennt)
    groupDarts(d) {
      const { w, h } = this;
      const comps = components(dilate(d.bin, w, h), w, h, 3).map((pix) => pix.filter((p) => d.bin[p])).filter((p) => p.length >= 2);
      const R = this.ref.img;
      const info = comps.map((c) => {
        let cx = 0, cy = 0, inner = 0, edge = 0;
        for (const p of c) {
          cx += p % w; cy += (p / w) | 0;
          if (this.radius[p] < SEED_R / 2) inner++;
          if (p > w && p < w * h - w && Math.abs(R[p + 1] - R[p - 1]) + Math.abs(R[p + w] - R[p - w]) > 50) edge++;
        }
        // dünner Saum fast nur auf Kanten der Referenz = Rest einer minimalen Bewegung, kein Pfeil
        return { cx: cx / c.length, cy: cy / c.length, inner, artifact: edge > 0.6 * c.length };
      });
      const used = info.map((x) => x.artifact);
      const groups = [];
      const minPx = this.minPx();
      for (let s = 0; s < comps.length; s++) {
        // ein Pfeil muss (zumindest teilweise) auf der Scheibe liegen – Befestigungen/Wand außen starten nichts
        if (used[s] || comps[s].length < minPx * 0.4 || info[s].inner < 3) continue;
        used[s] = true;
        let pix = comps[s].slice();
        for (let guard = 0; guard < 5; guard++) {
          const P = pca(pix, w);
          const sc = this.scaleAt(P.mx, P.my);
          // erwartete Pfeilrichtung (Spitze -> Flight) aus dem Kameramodell
          let fl = null, expLen = 110 * sc;
          if (this.cam) {
            const [bx, by] = applyH(this.H, (P.mx + 0.5) / w, (P.my + 0.5) / h);
            const e = this.cam.flightDir(bx, by, 110), el = Math.hypot(e[0], e[1]);
            if (el > 3) { fl = [e[0] / el, e[1] / el]; expLen = el; }
          }
          let dir = P.dir, ctr = [P.mx, P.my];
          // gemessene Achse, sobald der Fleck länglich ist; sonst die vom Kameramodell erwartete Richtung (ungenauer)
          const measured = (P.l1 > 2.5 * P.l2 && pix.length >= 30) || !fl;
          if (measured) { const A = fitAxis(pix, w); dir = A.d; ctr = A.o; }
          else dir = fl;
          const angTol = measured ? 0.14 : 0.4; // tan(Winkelunsicherheit)
          if (fl && dir[0] * fl[0] + dir[1] * fl[1] < 0) dir = [-dir[0], -dir[1]]; // +Richtung = Richtung Flight
          let tmin = Infinity, tmax = -Infinity;
          for (const p of pix) { const t = ((p % w) - ctr[0]) * dir[0] + (((p / w) | 0) - ctr[1]) * dir[1]; if (t < tmin) tmin = t; if (t > tmax) tmax = t; }
          // Korridor: Richtung Spitze ein Stück, Richtung Flight bis zur vollen Pfeillänge
          // Korridor entlang der Achse: Teile desselben Pfeils (Spitze, Barrel, Flight) liegen höchstens eine Pfeillänge entfernt
          const reach = Math.max(expLen * 1.2, 40 * sc);
          // Richtung Spitze: bis ~40 mm (sichtbare Spitze + vorderes Barrel, schräg steckende Pfeile wirken länger)
          const lo = Math.min(tmin - Math.max(40 * sc, 0.5 * expLen), tmax - reach) - 4, hi = Math.max(tmax + 20 * sc, tmin + reach) + 4;
          const perp = (t) => 5 * sc + 3 + (t > tmax ? Math.min(25 * sc, (angTol + 0.12) * (t - tmax)) : t < tmin ? Math.min(25 * sc, angTol * (tmin - t)) : 0);
          let changed = false;
          for (let k = 0; k < comps.length; k++) {
            if (used[k]) continue;
            // nächster Punkt des Teils zur Achse (nicht nur der Schwerpunkt: kleine Spitzen-Stücke liegen oft schief)
            let ok = false;
            const c = comps[k], step = Math.max(1, Math.floor(c.length / 40));
            for (let j = 0; j < c.length && !ok; j += step) {
              const x = c[j] % w, y = (c[j] / w) | 0;
              const t = (x - ctr[0]) * dir[0] + (y - ctr[1]) * dir[1], q = Math.abs(-(x - ctr[0]) * dir[1] + (y - ctr[0 + 1]) * dir[0]);
              if (t > lo && t < hi && q < perp(t)) ok = true;
            }
            if (ok) { used[k] = true; pix = pix.concat(c); changed = true; }
          }
          if (!changed) break;
        }
        groups.push(pix);
      }
      return groups.sort((a, b) => b.length - a.length);
    }

    // Prüft, ob ein Fleck wie ein Pfeil aussieht, und bestimmt die Spitze
    analyze(seedPix, d) {
      const { w, h } = this;
      // nur entlang der Pfeilachse wachsen (sonst läuft es an Drähten/Ringkanten quer über die Scheibe)
      const ax0 = fitAxis(seedPix, w);
      let s0 = Infinity, s1 = -Infinity;
      for (const p of seedPix) { const t = ((p % w) - ax0.o[0]) * ax0.d[0] + (((p / w) | 0) - ax0.o[1]) * ax0.d[1]; if (t < s0) s0 = t; if (t > s1) s1 = t; }
      const sc0 = this.scaleAt(ax0.o[0], ax0.o[1]);
      const reach = 12 * sc0 + 4, side = 8 * sc0 + 3;
      const allow = (x, y) => {
        const t = (x - ax0.o[0]) * ax0.d[0] + (y - ax0.o[1]) * ax0.d[1], q = Math.abs(-(x - ax0.o[0]) * ax0.d[1] + (y - ax0.o[1]) * ax0.d[0]);
        return t > s0 - reach && t < s1 + reach && q < side;
      };
      const pix = grow(seedPix, d.weak, w, h, seedPix.length * 2 + 200, allow);
      const ax = fitAxis(pix, w);
      let dir = ax.d;
      // Längen entlang der Achse
      let tmin = Infinity, tmax = -Infinity;
      for (const p of pix) { const t = ((p % w) - ax.o[0]) * dir[0] + (((p / w) | 0) - ax.o[1]) * dir[1]; if (t < tmin) tmin = t; if (t > tmax) tmax = t; }
      const L = tmax - tmin;
      const cx = ax.o[0] + dir[0] * (tmin + tmax) / 2, cy = ax.o[1] + dir[1] * (tmin + tmax) / 2;
      const sc = this.scaleAt(cx, cy);
      const width = pix.length / Math.max(1, L);
      // erwartete Länge eines Pfeils an dieser Stelle (Kameramodell, Pfeil ~ senkrecht)
      let flight = null, expLen = 110 * sc, ptPx = 16 * sc;
      if (this.cam) {
        const [bx, by] = applyH(this.H, (cx + 0.5) / w, (cy + 0.5) / h);
        const e = this.cam.flightDir(bx, by, 110);
        expLen = Math.hypot(e[0], e[1]);
        if (expLen > 3) flight = [e[0] / expLen, e[1] / expLen];
      }
      // --- Plausibilität ---
      if (L < 5 * sc && pix.length < 60) return { reject: 'zu klein' };
      if (L > 1.3 * expLen + 60 * sc + 12) return { reject: 'zu lang' };
      if (width > 40 * sc + 4) return { reject: 'zu breit' };
      // Kanten-Artefakt (z. B. Befestigung minimal verschoben): dünn und fast nur auf starken Kanten der Referenz
      if (width < 2.2) {
        let edge = 0;
        const R = this.ref.img;
        for (const p of seedPix) {
          const x = p % w, y = (p / w) | 0;
          if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
          if (Math.abs(R[p + 1] - R[p - 1]) + Math.abs(R[p + w] - R[p - w]) > 60) edge++;
        }
        if (edge > 0.6 * seedPix.length) return { reject: 'Kante' };
      }
      // --- Richtung: Spitze am Ende Richtung Scheibe ---
      let tipLow; // true: Spitze am Ende mit kleinem t
      if (this.tipMode === 'lowest' || this.tipMode === 'highest') {
        const yLow = ax.o[1] + dir[1] * tmin, yHigh = ax.o[1] + dir[1] * tmax;
        tipLow = this.tipMode === 'lowest' ? yLow > yHigh : yLow < yHigh;
      } else if (flight && Math.abs(dir[0] * flight[0] + dir[1] * flight[1]) > 0.35) {
        tipLow = dir[0] * flight[0] + dir[1] * flight[1] > 0; // Flight liegt in +Richtung -> Spitze bei tmin
      } else {
        // Fallback: schmales Ende ist die Spitze
        const band = 0.25 * L;
        const cnt = (lo, hi) => { let k = 0; for (const p of pix) { const t = ((p % w) - ax.o[0]) * dir[0] + (((p / w) | 0) - ax.o[1]) * dir[1]; if (t >= lo && t <= hi) k++; } return k; };
        tipLow = cnt(tmin, tmin + band) <= cnt(tmax - band, tmax);
      }
      const s = tipLow ? -1 : 1; // Laufrichtung zur Spitze
      // Front: äußerster Punkt nahe der Achse
      let front = tipLow ? Infinity : -Infinity;
      for (const p of pix) {
        const x = p % w, y = (p / w) | 0;
        const t = (x - ax.o[0]) * dir[0] + (y - ax.o[1]) * dir[1], q = Math.abs(-(x - ax.o[0]) * dir[1] + (y - ax.o[1]) * dir[0]);
        if (q > 2.5) continue;
        if (tipLow ? t < front : t > front) front = t;
      }
      if (!Number.isFinite(front)) front = tipLow ? tmin : tmax;
      // --- Spitze verlängern: entlang der Achse weitersuchen, solange sich das Bild (schwach) unterscheidet ---
      if (this.cam) {
        const fx = ax.o[0] + dir[0] * front, fy = ax.o[1] + dir[1] * front;
        const [bx, by] = applyH(this.H, (fx + 0.5) / w, (fy + 0.5) / h);
        ptPx = Math.hypot(...this.cam.flightDir(bx, by, 18));
      }
      const [ext, lat] = this.extendTip(ax.o, dir, front, s, d.C, Math.max(6, 1.7 * ptPx + 4));
      // Sub-Pixel: Ende der Spitze dort, wo der Unterschied auf die Hälfte des Spitzen-Kontrasts abfällt
      const tipT = this.refineTip(ax.o, dir, front + s * ext, lat, s, d.C);
      const tx = ax.o[0] + dir[0] * tipT - dir[1] * lat, ty = ax.o[1] + dir[1] * tipT + dir[0] * lat;
      this.lastAnalyze = (this.lastAnalyze || '') + ` [n=${pix.length} L=${L.toFixed(0)} exp=${expLen.toFixed(0)} front=${(ax.o[0] + dir[0] * front).toFixed(0)},${(ax.o[1] + dir[1] * front).toFixed(0)} ext=${ext.toFixed(1)}/${Math.max(6, 1.7 * ptPx + 4).toFixed(0)} tip=${tx.toFixed(0)},${ty.toFixed(0)}]`;
      return { tip: [tx, ty], tipDir: [dir[0] * s, dir[1] * s], pix, L, width, expLen, ext, sc };
    }

    // Unterschied an einer beliebigen (Sub-Pixel-)Stelle, bilinear aus den 4 Nachbarpixeln
    diffAt(C, px, py) {
      const { w, h } = this;
      const TL = Math.max(7, this.threshold * 0.25), TCL = Math.max(7, this.threshold * 0.25);
      const x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0;
      if (x0 < 1 || y0 < 1 || x0 >= w - 2 || y0 >= h - 2) return 0;
      let v = 0;
      for (const [dx, dy, k] of [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)], [0, 1, (1 - fx) * fy], [1, 1, fx * fy]]) {
        const x = x0 + dx, y = y0 + dy, i = y * w + x;
        if (!this.mask[i]) continue;
        C.at(x, y);
        const p = C.pixel(i);
        if (p) v += k * Math.max(p[0] / TL, p[1] / TCL);
      }
      return v;
    }

    // Spitzen-Ende auf Bruchteile eines Pixels: Halbwert-Durchgang des Unterschieds entlang der Achse
    refineTip(o, dir, tipT, lat, s, C) {
      const nx = -dir[1], ny = dir[0];
      const at = (k) => {
        const t = tipT + s * k;
        const px = o[0] + dir[0] * t + nx * lat, py = o[1] + dir[1] * t + ny * lat;
        // quer zur Achse das Maximum (die Spitze ist dünn, die Achse evtl. minimal versetzt)
        let m = 0;
        for (const q of [-0.75, -0.25, 0.25, 0.75]) m = Math.max(m, this.diffAt(C, px + nx * q, py + ny * q));
        return m;
      };
      const body = [];
      for (let k = -5; k <= -1.5; k += 0.5) body.push(at(k));
      body.sort((a, b) => a - b);
      const ref = body[body.length >> 1];
      if (!(ref >= 1.2)) return tipT;
      const half = 0.5 * ref;
      let prevK = -1.5, prevV = at(-1.5), cross = null;
      for (let k = -1.25; k <= 3; k += 0.25) {
        const v = at(k);
        if (prevV >= half && v < half) { cross = prevK + ((prevV - half) / (prevV - v)) * 0.25; }
        if (v >= half) cross = null; // weiter innerhalb der Spitze
        prevK = k; prevV = v;
      }
      if (cross === null) return tipT;
      return tipT + s * cross;
    }

    // Sucht ab der Front weiter Richtung Spitze und folgt dabei einer dünnen Linie (die Spitze kann leicht
    // schräg zur geschätzten Achse liegen). Liefert [Strecke entlang der Achse, seitlicher Versatz] in Pixeln.
    extendTip(o, dir, front, s, C, maxExt) {
      const { w, h } = this;
      const N = C.N;
      const TL = Math.max(7, this.threshold * 0.25), TCL = Math.max(7, this.threshold * 0.25);
      const nx = -dir[1], ny = dir[0];
      const score = (px, py) => {
        const x = Math.round(px), y = Math.round(py);
        if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) return 0;
        const i = y * w + x;
        if (!this.mask[i]) return 0;
        C.at(x, y);
        const p = C.pixel(i);
        return p ? Math.max(p[0] / TL, p[1] / TCL) : 0;
      };
      let last = 0, lastLat = 0, lat = 0;
      for (let k = 0.5; k <= maxExt; k += 0.5) {
        const t = front + s * k;
        const cx = o[0] + dir[0] * t, cy = o[1] + dir[1] * t;
        const maxLat = 1.5 + 0.2 * k; // höchstens ~11° Abweichung von der Achse
        let best = 0, bq = lat;
        for (let q = lat - 1.5; q <= lat + 1.5; q += 0.5) {
          if (Math.abs(q) > maxLat) continue;
          const sc = score(cx + nx * q, cy + ny * q) - Math.abs(q - lat) * 0.05; // leichte Vorliebe für gerade weiter
          if (sc > best) { best = sc; bq = q; }
        }
        if (best >= 1) { last = k; lastLat = bq; lat = 0.6 * lat + 0.4 * bq; }
        else if (k - last > 2.5) break; // Lücke -> Ende der Spitze
      }
      return [last, lastLat];
    }

    evaluate() {
      const minPx = this.minPx();
      const maxPx = this.boardPx * 0.15;
      let d = this.diff(this.cur, this.ref, true);

      // Kleine Erschütterung (gemessen, < 2,5 Pixel): Kalibrierung exakt mitschieben, Bildvergleich gleicht sie ohnehin aus
      let sh = 0;
      for (const [cx, cy] of [[0, 0], [this.w, 0], [0, this.h], [this.w, this.h], [this.w / 2, this.h / 2]]) sh = Math.max(sh, Math.hypot(...this.motionAt(d.C.P, cx, cy)));
      if (this.autoTrack && sh > 0.2 && sh < 2.5 && !this.lost) this.shiftCalibration(d.C.P);
      // Großer Unterschied oder typisches Verrutsch-Muster? Lage über die Farbringe neu bestimmen
      if (this.autoTrack && (d.count > maxPx || this.lost || sh >= 2.5 || (d.count > 4 * minPx && this.slipLikely(d)))) {
        const r = this.realign(40);
        if (!r || r.lost) return;
        if (r.moved) {
          d = this.diff(this.cur, this.ref, true);
          this.status('Kamera verrutscht – nachgeführt');
        }
      }
      if (this.lost) return;

      if (this.phase === 'pull') {
        const e = this.diff(this.cur, this.emptyRef, false);
        if (e.count < minPx * 2) {
          this.ref = this.snapRef();
          this.emptyRef = this.ref;
          this.awaitClear = false;
          this.turnBlobs = []; this.exclude = null; this.turnDarts = 0;
          this.status('Scheibe frei');
          this.cb.onCleared && this.cb.onCleared();
        } else {
          this.status('Pfeile ziehen …');
        }
        return;
      }
      if (this.phase !== 'throw') {
        this.ref = this.snapRef();
        this.status('Pausiert');
        return;
      }

      if (this.awaitClear && this.emptyRef) {
        const e = this.diff(this.cur, this.emptyRef, true);
        if (e.count < minPx * 2) {
          // alte Pfeile gezogen -> ab jetzt normale Aufnahme
          this.ref = this.snapRef(); this.emptyRef = this.ref; this.awaitClear = false;
          this.turnBlobs = []; this.exclude = null;
          this.status('Scheibe frei – wirf!');
          return;
        }
        // Stellen, die wieder wie die leere Scheibe aussehen (gezogene Pfeile), sind keine neuen Würfe
        let c = 0;
        for (let i = 0; i < d.bin.length; i++) { if (d.bin[i] && !e.bin[i]) d.bin[i] = 0; c += d.bin[i]; }
        d.count = c;
        if (d.count < minPx) { this.ref = this.snapRef(); this.status('Pfeile ziehen …'); return; }
      }
      if (d.count < minPx) {
        this.ref = this.snapRef(); // kleine Licht-Schwankungen übernehmen
        this.status('Bereit – wirf!');
        return;
      }
      // Sieht die Scheibe wieder aus wie zu Beginn der Aufnahme? -> Pfeile wurden gezogen
      if (this.emptyRef && this.emptyRef !== this.ref && this.diff(this.cur, this.emptyRef, false).count < minPx * 2) {
        this.ref = this.snapRef();
        this.emptyRef = this.ref;
        this.turnBlobs = []; this.exclude = null; this.turnDarts = 0;
        this.status('Scheibe frei');
        this.cb.onCleared && this.cb.onCleared();
        return;
      }
      if (d.count > maxPx) {
        this.ref = this.snapRef();
        this.status('Große Änderung – Referenz neu gesetzt');
        this.cb.onLargeChange && this.cb.onLargeChange();
        return;
      }

      this.lastAnalyze = '';
      const groups = this.groupDarts(d);
      const found = [], rejected = [];
      for (const g of groups) {
        if (g.length < minPx) break;
        const r = this.analyze(g, d);
        if (r.reject) { rejected.push(r.reject); continue; }
        // Spitze außerhalb der Scheibe? Dann ist das (ohne Auto-Miss) kein Treffer – evtl. ist ein anderer Fleck der Pfeil
        const [obx, oby] = applyH(this.H, (r.tip[0] + 0.5) / this.w, (r.tip[1] + 0.5) / this.h);
        if (Math.hypot(obx, oby) > OUTSIDE_R && !this.autoMiss) { rejected.push('außerhalb der Scheibe'); continue; }
        // Plausibilität der Größe: ein Pfeil ist (auch teilweise verdeckt) ein deutliches Stück lang;
        // knapp außerhalb des Doppelrings (Miss) verlangen wir einen eindeutig ganzen Pfeil
        const rr = Math.hypot(obx, oby);
        if (r.L < 0.22 * r.expLen) { rejected.push('zu klein'); continue; }
        if (rr > 170 && (r.L < 0.4 * r.expLen || g.length < 2 * minPx)) { rejected.push('außerhalb der Scheibe'); continue; }
        // weitere Pfeile im selben Bild nur, wenn sie eindeutig eigenständig sind (zwei schnelle Würfe)
        if (found.length) {
          if (g.length < 2.5 * minPx || r.L < 0.45 * r.expLen) continue;
          const far = found.every((f) => Math.hypot(f.tip[0] - r.tip[0], f.tip[1] - r.tip[1]) > 30 * r.sc);
          if (!far) continue;
        }
        found.push(r);
        if (found.length >= 3) break;
      }
      this.lastDebug = { bin: d.bin, w: this.w, h: this.h, rejected };
      if (!found.length) {
        this.ref = this.snapRef();
        this.status(rejected.length ? `Ignoriert (${rejected[0]})` : 'Bereit – wirf!');
        return;
      }
      const emitted = [];
      let emittedAny = false;
      for (const r of found) {
        const u = (r.tip[0] + 0.5) / this.w, v = (r.tip[1] + 0.5) / this.h;
        const [bx, by] = applyH(this.H, u, v);
        const rad = Math.hypot(bx, by);
        if (rad > 170 && (rad > OUTSIDE_R || emittedAny)) {
          // außerhalb: nur als "Miss" zählen, wenn gewünscht und der Fleck eindeutig ein ganzer Pfeil ist
          if (!this.autoMiss || r.L < 0.45 * r.expLen) { rejected.push('außerhalb der Scheibe'); continue; }
        }
        // Richtung zur Spitze auf der Scheibe (mm) – für die gelernte Korrektur aus Nutzer-Korrekturen
        const [qx, qy] = applyH(this.H, (r.tip[0] + r.tipDir[0] * 4 + 0.5) / this.w, (r.tip[1] + r.tipDir[1] * 4 + 0.5) / this.h);
        const bl = Math.hypot(qx - bx, qy - by) || 1;
        const bdir = [(qx - bx) / bl, (qy - by) / bl];
        const fx = bx + bdir[0] * (this.tipBias || 0), fy = by + bdir[1] * (this.tipBias || 0);
        const dart = Board.score(fx, fy);
        dart.x = fx; dart.y = fy; dart.auto = true; dart.bdir = [Math.round(bdir[0] * 1000) / 1000, Math.round(bdir[1] * 1000) / 1000];
        dart.cid = this.capture(r.tip, Board.label(dart), fx, fy);
        emitted.push({ dart, u, v, pix: r.pix });
        emittedAny = true;
      }
      this.ref = this.snapRef();
      this.exclude = null;
      if (!emitted.length) { this.status(`Ignoriert (${rejected[0]})`); return; }
      for (const e of emitted) {
        (this.turnBlobs || (this.turnBlobs = [])).push(e.pix);
        this.turnDarts = (this.turnDarts || 0) + 1;
        this.lastDebug.tip = [e.u, e.v];
        (this.lastDebug.tips || (this.lastDebug.tips = [])).push([e.u, e.v, Board.label(e.dart)]);
        this.status('Treffer: ' + Board.label(e.dart));
        this.cb.onDart && this.cb.onDart(e.dart, { u: e.u, v: e.v });
      }
    }

    // Bildausschnitt um einen erkannten Pfeil merken (vorher/nachher) – für das Erkennungsprotokoll
    capture(tip, label, x, y) {
      const id = (this.capN = (this.capN || 0) + 1);
      try {
        const { w, h } = this, R = 64;
        const cx = Math.round(tip[0]), cy = Math.round(tip[1]);
        const before = new Uint8ClampedArray(4 * R * R * 4), after = new Uint8ClampedArray(4 * R * R * 4);
        for (let yy = 0; yy < 2 * R; yy++) for (let xx = 0; xx < 2 * R; xx++) {
          const sx = cx - R + xx, sy = cy - R + yy, o = (yy * 2 * R + xx) * 4;
          if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
          const i = sy * w + sx, g = this.ref.img[i];
          before[o] = before[o + 1] = before[o + 2] = g; before[o + 3] = 255;
          after[o] = this.rgba[i * 4]; after[o + 1] = this.rgba[i * 4 + 1]; after[o + 2] = this.rgba[i * 4 + 2]; after[o + 3] = 255;
        }
        (this.captures || (this.captures = [])).push({ id, label, x, y, tip: [cx, cy], size: 2 * R, before, after, t: Date.now() });
        if (this.captures.length > 8) this.captures.shift();
      } catch (_) {}
      return id;
    }

    // Aus einer Nutzer-Korrektur lernen: Liegt die erkannte Spitze immer wieder ein Stück zu weit hinten (oder vorne)
    // entlang des Pfeils, wird die Spitze künftig um diesen Betrag verschoben. Seitliche Fehler werden nicht gelernt.
    learnFromCorrection(detected, corrected) {
      if (!detected || !detected.auto || !detected.bdir || !Number.isFinite(detected.x)) return null;
      const target = Board.nearestInField(corrected, detected.x, detected.y);
      if (!target) return null;
      const vx = target[0] - detected.x, vy = target[1] - detected.y;
      const along = vx * detected.bdir[0] + vy * detected.bdir[1];
      const lat = Math.hypot(vx - along * detected.bdir[0], vy - along * detected.bdir[1]);
      if (lat > 3 || Math.abs(along) > 15) return null; // nicht mit einem Längenfehler erklärbar
      const S = (this.biasSamples || (this.biasSamples = []));
      S.push(along);
      if (S.length > 12) S.shift();
      if (S.length >= 4) {
        const sorted = S.slice().sort((a, b) => a - b), med = sorted[sorted.length >> 1];
        const same = S.filter((v) => Math.sign(v) === Math.sign(med)).length / S.length;
        if (Math.abs(med) > 0.8 && same >= 0.7) {
          this.tipBias = Math.max(-8, Math.min(8, (this.tipBias || 0) + 0.7 * med));
          this.biasSamples = [];
          this.cb.onBias && this.cb.onBias(this.tipBias);
        }
      }
      return along;
    }

    // Live-Differenzbild für die Debug-Ansicht
    debugMask() {
      if (!this.ref || !this.cur || !this.mask) return null;
      this.ensureGray();
      return { bin: this.diff(this.cur, this.ref, true).bin, w: this.w, h: this.h };
    }
  }

  return { DartDetector, makeRef, solveH, applyH, invertH, findTip, fitAxis, largestComponent, components, dilate, CAL_DST, MIN_QUALITY };
});
