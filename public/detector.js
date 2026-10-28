// Pfeilerkennung per Bilddifferenz.
// Ablauf: Referenzbild der Scheibe -> nach jedem Wurf (Bild wieder ruhig) Unterschied zur Referenz
// -> größter Fleck = neuer Pfeil -> Spitze suchen -> per Homographie in Scheiben-Koordinaten (mm) -> Punkte.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root.Board || require('./board.js'));
  else root.Detector = factory(root.Board);
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
    const inv = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d];
    return inv.map((v) => v / det);
  }

  // ---------- Fleck-Analyse ----------
  // Größte zusammenhängende Fläche (8er-Nachbarschaft) in einer Binärmaske
  function largestComponent(bin, w, h) {
    const seen = new Uint8Array(w * h);
    const stack = new Int32Array(w * h);
    let best = null;
    for (let s = 0; s < w * h; s++) {
      if (!bin[s] || seen[s]) continue;
      let sp = 0, n = 0;
      const pix = [];
      stack[sp++] = s; seen[s] = 1;
      while (sp) {
        const p = stack[--sp];
        pix.push(p); n++;
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
      if (!best || n > best.length) best = pix;
    }
    return best || [];
  }

  function dilate(bin, w, h) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!bin[y * w + x]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w) out[yy * w + xx] = 1;
        }
      }
    }
    return out;
  }

  // Spitze finden: Hauptachse des Flecks, dann das schmalere Ende (Flight ist breit, Spitze schmal)
  function findTip(pix, w, mode) {
    const n = pix.length;
    if (!n) return null;
    let mx = 0, my = 0;
    for (const p of pix) { mx += p % w; my += (p / w) | 0; }
    mx /= n; my /= n;
    if (mode === 'lowest' || mode === 'highest') {
      let ext = mode === 'lowest' ? -Infinity : Infinity;
      for (const p of pix) {
        const y = (p / w) | 0;
        ext = mode === 'lowest' ? Math.max(ext, y) : Math.min(ext, y);
      }
      let sx = 0, sy = 0, c = 0;
      for (const p of pix) {
        const y = (p / w) | 0;
        if (Math.abs(y - ext) <= 1) { sx += p % w; sy += y; c++; }
      }
      return { x: sx / c, y: sy / c, length: 0 };
    }
    let cxx = 0, cyy = 0, cxy = 0;
    for (const p of pix) {
      const dx = (p % w) - mx, dy = ((p / w) | 0) - my;
      cxx += dx * dx; cyy += dy * dy; cxy += dx * dy;
    }
    const th = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    const c = Math.cos(th), s = Math.sin(th);
    const T = new Float32Array(n), P = new Float32Array(n);
    let tmin = Infinity, tmax = -Infinity;
    for (let i = 0; i < n; i++) {
      const dx = (pix[i] % w) - mx, dy = ((pix[i] / w) | 0) - my;
      T[i] = dx * c + dy * s;
      P[i] = -dx * s + dy * c;
      if (T[i] < tmin) tmin = T[i];
      if (T[i] > tmax) tmax = T[i];
    }
    const L = tmax - tmin;
    if (L < 10) return { x: mx, y: my, length: L };
    const band = 0.25 * L;
    const spread = (lo, hi) => {
      let m = 0, k = 0;
      for (let i = 0; i < n; i++) if (T[i] >= lo && T[i] <= hi) { m += P[i]; k++; }
      if (!k) return Infinity;
      m /= k;
      let v = 0;
      for (let i = 0; i < n; i++) if (T[i] >= lo && T[i] <= hi) v += (P[i] - m) ** 2;
      return Math.sqrt(v / k) + k / band * 0.05; // Breite + etwas Gewicht auf Pixelmenge
    };
    const sLow = spread(tmin, tmin + band);
    const sHigh = spread(tmax - band, tmax);
    const lowEnd = sLow < sHigh;
    const ext = lowEnd ? tmin : tmax;
    const tol = Math.max(1.5, 0.03 * L);
    let sx = 0, sy = 0, k = 0;
    for (let i = 0; i < n; i++) {
      if (Math.abs(T[i] - ext) <= tol) { sx += pix[i] % w; sy += (pix[i] / w) | 0; k++; }
    }
    return { x: sx / k, y: sy / k, length: L };
  }

  // ---------- Detektor (Browser) ----------
  class DartDetector {
    constructor(cb = {}) {
      this.cb = cb;
      this.procW = 480;
      this.threshold = 28;     // Helligkeitsunterschied pro Pixel
      this.tipMode = 'auto';   // auto | lowest | highest
      this.phase = 'idle';     // idle | throw | pull
      this.H = null; this.Hinv = null; this.calib = null;
      this.w = 0; this.h = 0;
      this.running = false;
      this.stable = 0; this.evaluated = true;
      this.lastDebug = null;
      if (typeof document !== 'undefined') {
        this.canvas = document.createElement('canvas');
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      }
    }

    setCalibration(pts) {
      this.calib = pts;
      this.H = pts ? solveH(pts, CAL_DST) : null;
      this.Hinv = this.H ? invertH(this.H) : null;
      this.mask = null;
      this.ref = null;
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

    stop() { this.running = false; clearTimeout(this.timer); this.ref = null; }

    ensureSize() {
      const v = this.video;
      if (!v || !v.videoWidth) return false;
      const w = this.procW, h = Math.round((this.procW * v.videoHeight) / v.videoWidth);
      if (w !== this.w || h !== this.h) {
        this.w = w; this.h = h;
        this.canvas.width = w; this.canvas.height = h;
        this.cur = new Uint8Array(w * h);
        this.tmp = new Uint8Array(w * h);
        this.prev = null; this.ref = null; this.mask = null;
      }
      return true;
    }

    buildMask() {
      const { w, h } = this;
      this.mask = new Uint8Array(w * h);
      let n = 0, inner = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const [bx, by] = applyH(this.H, (x + 0.5) / w, (y + 0.5) / h);
        // großzügig: auch Schaft/Flight von Randtreffern liegen oft außerhalb des Doppelrings
        const r = Math.hypot(bx, by);
        if (r < 235) { this.mask[y * w + x] = 1; n++; }
        if (r < 182) inner++;
      }
      this.boardPx = Math.max(inner, 1);
      this.maskPx = Math.max(n, 1);
    }

    grab() {
      const { w, h, ctx } = this;
      ctx.drawImage(this.video, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h).data;
      const g = this.tmp, out = this.cur;
      for (let i = 0, j = 0; i < w * h; i++, j += 4) g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
      // 3x3-Weichzeichner gegen Rauschen
      for (let y = 0; y < h; y++) {
        const y0 = Math.max(0, y - 1), y1 = Math.min(h - 1, y + 1);
        for (let x = 0; x < w; x++) {
          const x0 = Math.max(0, x - 1), x1 = Math.min(w - 1, x + 1);
          let s = 0, c = 0;
          for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) { s += g[yy * w + xx]; c++; }
          out[y * w + x] = (s / c) | 0;
        }
      }
    }

    // Unterschied zweier Bilder innerhalb der Scheibe, mit Ausgleich globaler Helligkeitsänderung
    diff(a, b, wantMask) {
      const { mask, w, h } = this;
      const T = this.threshold;
      let sa = 0, sb = 0;
      for (let i = 0; i < w * h; i++) if (mask[i]) { sa += a[i]; sb += b[i]; }
      const off = (sa - sb) / this.maskPx;
      const bin = wantMask ? new Uint8Array(w * h) : null;
      let count = 0;
      for (let i = 0; i < w * h; i++) {
        if (mask[i] && Math.abs(a[i] - b[i] - off) > T) { count++; if (bin) bin[i] = 1; }
      }
      return { count, bin };
    }

    snapshot() { return this.cur ? this.cur.slice() : null; }

    // Neue Aufnahme beginnen (Scheibe leer)
    startTurn() {
      this.ref = this.snapshot();
      this.emptyRef = this.ref;
      this.evaluated = true;
      this.phase = 'throw';
    }

    // Aktuellen Zustand als Referenz übernehmen (z. B. nach manueller Eingabe)
    rebaseline() {
      this.ref = this.snapshot();
      this.evaluated = true;
    }

    tick() {
      if (!this.ensureSize() || !this.H) return;
      if (!this.mask) this.buildMask();
      this.grab();
      if (!this.prev) {
        this.prev = this.snapshot();
        this.ref = this.snapshot();
        this.emptyRef = this.ref;
        return;
      }
      if (!this.ref) { this.ref = this.snapshot(); this.emptyRef = this.ref; }
      const motion = this.diff(this.cur, this.prev, false).count;
      this.prev.set(this.cur);
      if (motion > this.boardPx * 0.004) {
        this.stable = 0;
        this.evaluated = false;
        this.status('Bewegung …');
        return;
      }
      this.stable++;
      if (this.stable < 3 || this.evaluated) return;
      this.evaluated = true;
      this.evaluate();
    }

    status(s) {
      if (s !== this.lastStatus) { this.lastStatus = s; this.cb.onStatus && this.cb.onStatus(s); }
    }

    evaluate() {
      const minPx = Math.max(25, this.boardPx * 0.0012);
      const maxPx = this.boardPx * 0.15;

      if (this.phase === 'pull') {
        const d = this.diff(this.cur, this.emptyRef, false);
        if (d.count < minPx * 2) {
          this.ref = this.snapshot();
          this.emptyRef = this.ref;
          this.status('Scheibe frei');
          this.cb.onCleared && this.cb.onCleared();
        } else {
          this.status('Pfeile ziehen …');
        }
        return;
      }
      if (this.phase !== 'throw') {
        this.ref = this.snapshot();
        this.status('Pausiert');
        return;
      }

      const d = this.diff(this.cur, this.ref, true);
      if (d.count < minPx) {
        this.ref = this.snapshot(); // kleine Licht-Schwankungen übernehmen
        this.status('Bereit – wirf!');
        return;
      }
      // Sieht die Scheibe wieder aus wie zu Beginn der Aufnahme? -> Pfeile wurden gezogen
      if (this.emptyRef && this.emptyRef !== this.ref && this.diff(this.cur, this.emptyRef, false).count < minPx * 2) {
        this.ref = this.snapshot();
        this.emptyRef = this.ref;
        this.status('Scheibe frei');
        this.cb.onCleared && this.cb.onCleared();
        return;
      }
      if (d.count > maxPx) {
        this.ref = this.snapshot();
        this.status('Große Änderung – Referenz neu gesetzt');
        this.cb.onLargeChange && this.cb.onLargeChange();
        return;
      }
      const pix = largestComponent(dilate(d.bin, this.w, this.h), this.w, this.h);
      if (pix.length < minPx) {
        this.ref = this.snapshot();
        this.status('Bereit – wirf!');
        return;
      }
      const tip = findTip(pix, this.w, this.tipMode);
      const u = (tip.x + 0.5) / this.w, v = (tip.y + 0.5) / this.h;
      const [bx, by] = applyH(this.H, u, v);
      const dart = Board.score(bx, by);
      dart.x = bx; dart.y = by; dart.auto = true;
      this.lastDebug = { bin: d.bin, w: this.w, h: this.h, tip: [u, v] };
      this.ref = this.snapshot();
      this.status('Treffer: ' + Board.label(dart));
      this.cb.onDart && this.cb.onDart(dart, { u, v });
    }

    // Live-Differenzbild für die Debug-Ansicht
    debugMask() {
      if (!this.ref || !this.cur || !this.mask) return null;
      return { bin: this.diff(this.cur, this.ref, true).bin, w: this.w, h: this.h };
    }
  }

  return { DartDetector, solveH, applyH, invertH, findTip, largestComponent, dilate, CAL_DST };
});
