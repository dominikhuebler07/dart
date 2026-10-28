// Pfeilerkennung per Bilddifferenz + automatische Scheibenerkennung/Nachführung.
// Ablauf: Referenzbild der Scheibe -> nach jedem Wurf (Bild wieder ruhig) Unterschied zur Referenz
// -> größter Fleck = neuer Pfeil -> Spitze suchen -> per Homographie in Scheiben-Koordinaten (mm) -> Punkte.
// Verrutscht die Kamera, findet BoardFinder die Scheibe über die Farbringe wieder und alles wird nachgezogen.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root.Board || require('./board.js'), root.BoardFinder || require('./boardfinder.js'));
  else root.Detector = factory(root.Board, root.BoardFinder);
})(typeof self !== 'undefined' ? self : this, function (Board, F) {
  const { CAL_DST, solveH, applyH, invertH } = F;
  const MIN_QUALITY = 0.12; // darunter gilt die Scheibe als "nicht gefunden"

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

  // Hysterese: Fleck in angrenzende Pixel mit schwächerem Unterschied wachsen lassen (dünne Spitze!)
  function grow(seed, weak, w, h) {
    const inSet = new Uint8Array(w * h);
    const out = seed.slice();
    for (const p of seed) inSet[p] = 1;
    for (let k = 0; k < out.length; k++) {
      const p = out[k], x = p % w, y = (p / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = yy * w + xx;
        if (!inSet[q] && weak[q]) { inSet[q] = 1; out.push(q); }
      }
      if (out.length > seed.length * 3 + 200) break; // Notbremse
    }
    return out;
  }

  // Spitze finden: Hauptachse des Flecks, dann das schmalere Ende (Flight ist breit, Spitze schmal)
  // expect: erwartete Bildrichtung Spitze -> Flight (aus dem Kameramodell), optional
  function findTip(pix, w, mode, expect) {
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
    // 1) Geometrie: Der Pfeil ragt aus der Scheibe Richtung Kamera -> Spitze ist das andere Ende
    let lowEnd = null;
    if (expect && (mode === 'auto' || !mode)) {
      const el = Math.hypot(expect[0], expect[1]);
      if (el > 4) {
        const d = (c * expect[0] + s * expect[1]) / el;
        if (Math.abs(d) > 0.7) lowEnd = d > 0; // Flight liegt Richtung +Achse -> Spitze am unteren Ende
      }
    }
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
    // 2) sonst: schmales Ende = Spitze (Flight ist breit)
    if (lowEnd === null) lowEnd = spread(tmin, tmin + band) < spread(tmax - band, tmax);
    const ext = lowEnd ? tmin : tmax;
    const tol = Math.max(1.5, 0.03 * L);
    let sx = 0, sy = 0, k = 0;
    for (let i = 0; i < n; i++) {
      if (Math.abs(T[i] - ext) <= tol) { sx += pix[i] % w; sy += (pix[i] / w) | 0; k++; }
    }
    return { x: sx / k, y: sy / k, length: L };
  }

  // 3x3-Minimum/Maximum eines Kanals (für den toleranten Vergleich)
  function minMax3(img, w, h) {
    const mn = new Uint8Array(w * h), mx = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - 1), y1 = Math.min(h - 1, y + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - 1), x1 = Math.min(w - 1, x + 1);
        let lo = 255, hi = 0;
        for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
          const v = img[yy * w + xx];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        mn[y * w + x] = lo; mx[y * w + x] = hi;
      }
    }
    return [mn, mx];
  }
  // Referenzbild: Helligkeit + Farbanteile (u: rot-grün, v: blau-grün).
  // tolerant=false: exakter Vergleich (frisches Bild); true: verzeiht 1 Pixel (nach Umrechnung auf neue Kameralage)
  function makeRef(img, w, h, tolerant, chroma) {
    const R = { img, mn: img, mx: img };
    if (chroma && chroma.u) { R.u = chroma.u; R.v = chroma.v; R.umn = R.umx = chroma.u; R.vmn = R.vmx = chroma.v; }
    if (tolerant) {
      [R.mn, R.mx] = minMax3(img, w, h);
      if (R.u) { [R.umn, R.umx] = minMax3(R.u, w, h); [R.vmn, R.vmx] = minMax3(R.v, w, h); }
    }
    return R;
  }

  // ---------- Detektor (Browser) ----------
  class DartDetector {
    constructor(cb = {}) {
      this.cb = cb;
      this.procW = 640;
      this.threshold = 28;     // Helligkeitsunterschied pro Pixel
      this.tipMode = 'auto';   // auto | lowest | highest
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
          for (let i = 0; i < img.length; i++) if (img.invalid[i]) {
            ref.mn[i] = 0; ref.mx[i] = 255;
            if (ref.u) { ref.umn[i] = 0; ref.umx[i] = 255; ref.vmn[i] = 0; ref.vmx[i] = 255; }
          }
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
      this.prev = null;           // nächstes Bild: Lage über die Farbringe prüfen
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

    stop() { this.running = false; clearTimeout(this.timer); this.ref = null; this.emptyRef = null; this.prev = null; }

    ensureSize() {
      const v = this.video;
      if (!v || !v.videoWidth) return false;
      const w = this.procW, h = Math.round((this.procW * v.videoHeight) / v.videoWidth);
      if (w !== this.w || h !== this.h) {
        this.w = w; this.h = h;
        this.canvas.width = w; this.canvas.height = h;
        this.cur = new Uint8Array(w * h);
        this.tmp = new Uint8Array(w * h);
        this.cu = new Uint8Array(w * h); this.cv = new Uint8Array(w * h);
        this.prev = null; this.ref = null; this.emptyRef = null; this.mask = null;
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
      // Kamera-Modell (Scheibe mm -> Bild Pixel), um die Pfeilrichtung vorherzusagen
      const S = [w, 0, 0, 0, h, 0, 0, 0, 1], Hn = this.Hinv, Hpx = [];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) { let v = 0; for (let k = 0; k < 3; k++) v += S[r * 3 + k] * Hn[k * 3 + c]; Hpx.push(v); }
      this.cam = F.cameraFromH(Hpx, w, h);
    }

    grab() {
      const { w, h, ctx } = this, v = this.video, c = this.view;
      const vw = v.videoWidth, vh = v.videoHeight;
      ctx.drawImage(v, c.x * vw, c.y * vh, c.w * vw, c.h * vh, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h).data;
      this.rgba = d;
      this.toGray(d);
    }

    toGray(d) {
      const { w, h } = this;
      const g = this.tmp, out = this.cur;
      if (!this.cu || this.cu.length !== w * h) { this.cu = new Uint8Array(w * h); this.cv = new Uint8Array(w * h); }
      const cu = this.cu, cv = this.cv;
      for (let i = 0, j = 0; i < w * h; i++, j += 4) {
        g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
        cu[i] = ((d[j] - d[j + 1]) >> 1) + 128;     // rot-grün
        cv[i] = ((d[j + 2] - d[j + 1]) >> 1) + 128; // blau-grün
      }
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

    // Unterschied Bild <-> Referenz innerhalb der Scheibe, mit Ausgleich globaler Helligkeit
    diff(a, R, wantMask) {
      const { mask, w, h } = this;
      const T = this.threshold;
      let sa = 0, sb = 0;
      for (let i = 0; i < w * h; i++) if (mask[i]) { sa += a[i]; sb += R.img[i]; }
      const off = (sa - sb) / this.maskPx;
      const bin = wantMask ? new Uint8Array(w * h) : null;
      const weak = wantMask ? new Uint8Array(w * h) : null; // schwacher Unterschied (für die Hysterese)
      const TW = T * 0.5;
      let count = 0;
      const useC = R.u && this.cu && a === this.cur, cu = this.cu, cv = this.cv, TC = T * 0.75;
      const umn = R.umn, umx = R.umx, vmn = R.vmn, vmx = R.vmx;
      for (let i = 0; i < w * h; i++) {
        if (!mask[i]) continue;
        const v = a[i] - off;
        const dy = v > R.mx[i] ? v - R.mx[i] : v < R.mn[i] ? R.mn[i] - v : 0;
        let dc = 0;
        if (useC) {
          const u = cu[i], c = cv[i];
          dc = (u < umn[i] ? umn[i] - u : u > umx[i] ? u - umx[i] : 0) + (c < vmn[i] ? vmn[i] - c : c > vmx[i] ? c - vmx[i] : 0);
        }
        if (dy > T || dc > TC) { count++; if (bin) bin[i] = 1; }
        if (weak && (dy > TW || dc > TC * 0.5)) weak[i] = 1;
      }
      return { count, bin, weak };
    }

    // einfacher Bewegungsvergleich zum vorigen Bild
    motion(a, b) {
      const { mask, w, h } = this, T = this.threshold;
      let c = 0;
      for (let i = 0; i < w * h; i++) if (mask[i] && Math.abs(a[i] - b[i]) > T) c++;
      return c;
    }

    snapRef() { return this.cur ? makeRef(this.cur.slice(), this.w, this.h, false, this.cu ? { u: this.cu.slice(), v: this.cv.slice() } : null) : null; }

    // Neue Aufnahme beginnen (Scheibe leer)
    startTurn() {
      this.turnDarts = 0;
      this.turnBlobs = [];
      this.exclude = null;
      this.ref = this.snapRef();
      this.emptyRef = this.ref;
      this.evaluated = true;
      this.phase = 'throw';
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
        this.prev = this.cur.slice();
        this.cb.onRealign && this.cb.onRealign({ moved, quality: r.quality, calib: this.calib });
        return { moved };
      }
      if (wasLost) { this.ref = this.snapRef(); this.emptyRef = this.ref; this.cb.onRealign && this.cb.onRealign({ moved: 0, quality: r.quality, calib: this.calib }); }
      return { moved: 0 };
    }

    minPx() { return Math.max(25, this.boardPx * 0.0012); }

    tick() {
      if (!this.ensureSize()) return;
      this.grab();
      if (!this.H) return;
      if (!this.mask) this.buildMask();
      if (!this.prev) {
        this.prev = this.cur.slice();
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
      if (!this.ref) { this.ref = this.snapRef(); this.emptyRef = this.ref; }
      const motion = this.motion(this.cur, this.prev);
      this.prev.set(this.cur);
      if (motion > Math.max(40, this.boardPx * 0.0015)) {
        this.stable = 0;
        this.evaluated = false;
        this.status('Bewegung …');
        return;
      }
      this.stable++;
      if (this.stable < 3) return;
      if (!this.evaluated) { this.evaluated = true; this.evaluate(); return; }
      if (this.lost && this.stable % 10 === 0) { this.realign(60); return; }
      if (this.autoTrack && this.stable % this.trackEvery === 0) { this.realign(12, true); return; }
      // zur Sicherheit regelmäßig nachsehen, falls ein Pfeil ohne erkannte Bewegung dazugekommen ist
      if (this.stable % 8 === 0) this.evaluate();
    }

    status(s) {
      if (s !== this.lastStatus) { this.lastStatus = s; this.cb.onStatus && this.cb.onStatus(s); }
    }

    evaluate() {
      const minPx = this.minPx();
      const maxPx = this.boardPx * 0.15;
      let d = this.diff(this.cur, this.ref, true);

      // Großer Unterschied? Zuerst prüfen, ob nur die Kamera verrutscht ist
      if (this.autoTrack && (d.count > maxPx || this.lost)) {
        const r = this.realign(40);
        if (!r || r.lost) return;
        if (r.moved) {
          d = this.diff(this.cur, this.ref, true);
          if (this.exclude) {
            let c = 0;
            for (let i = 0; i < d.bin.length; i++) { if (this.exclude[i]) d.bin[i] = 0; else c += d.bin[i]; }
            d.count = c;
          }
          this.status('Kamera verrutscht – nachgeführt');
        }
      }
      if (this.lost) return;

      if (this.phase === 'pull') {
        const e = this.diff(this.cur, this.emptyRef, false);
        if (e.count < minPx * 2) {
          this.ref = this.snapRef();
          this.emptyRef = this.ref;
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
      // Zusammenhang auf leicht verbreiterter Maske suchen, Spitze aber nur auf den echten Pixeln bestimmen
      const pix = grow(largestComponent(dilate(d.bin, this.w, this.h), this.w, this.h).filter((p) => d.bin[p]), d.weak, this.w, this.h);
      if (pix.length < minPx) {
        this.ref = this.snapRef();
        this.status('Bereit – wirf!');
        return;
      }
      let expect = null;
      if (this.cam) {
        // Richtung am Schwerpunkt des Flecks (grob auf die Scheibe projiziert)
        let mx = 0, my = 0;
        for (const p of pix) { mx += p % this.w; my += (p / this.w) | 0; }
        mx /= pix.length; my /= pix.length;
        const [cbx, cby] = applyH(this.H, (mx + 0.5) / this.w, (my + 0.5) / this.h);
        expect = this.cam.flightDir(cbx, cby);
      }
      const tip = findTip(pix, this.w, this.tipMode, expect);
      const u = (tip.x + 0.5) / this.w, v = (tip.y + 0.5) / this.h;
      const [bx, by] = applyH(this.H, u, v);
      const dart = Board.score(bx, by);
      dart.x = bx; dart.y = by; dart.auto = true;
      this.lastDebug = { bin: d.bin, w: this.w, h: this.h, tip: [u, v] };
      (this.turnBlobs || (this.turnBlobs = [])).push(pix);
      this.turnDarts = (this.turnDarts || 0) + 1;
      this.ref = this.snapRef();
      this.exclude = null;
      this.status('Treffer: ' + Board.label(dart));
      this.cb.onDart && this.cb.onDart(dart, { u, v });
    }

    // Live-Differenzbild für die Debug-Ansicht
    debugMask() {
      if (!this.ref || !this.cur || !this.mask) return null;
      return { bin: this.diff(this.cur, this.ref, true).bin, w: this.w, h: this.h };
    }
  }

  return { DartDetector, makeRef, solveH, applyH, invertH, findTip, largestComponent, dilate, CAL_DST, MIN_QUALITY };
});
