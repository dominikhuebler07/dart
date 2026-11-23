// Zwei Kameras zu einem genaueren Treffer verrechnen (Haupt-Handy + 2. Handy).
// Jede Kamera misst die Pfeilspitze quer zum Pfeil sehr genau, entlang des Pfeils (Blickrichtung) ungenauer.
// Stehen die Handys links und rechts, ergänzen sich ihre genauen Richtungen – ähnlich wie zwei Augen.
// Läuft im Browser und in den Tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./board.js'));
  else root.Fuse = factory(root.Board);
})(typeof self !== 'undefined' ? self : this, function (Board) {
  // Messunsicherheit (mm) aus der Bildauflösung der Kamera (mm pro Pixel auf der Scheibe)
  function sigma(q) {
    const mm = Number.isFinite(q) && q > 0 ? q : 1.2;
    return { along: 1.2 + 2.2 * mm, perp: 0.35 + 0.7 * mm };
  }
  // Informationsmatrix (Inverse der Kovarianz) einer Messung
  function info(m) {
    const s = sigma(m.q);
    let ux = m.bdir ? m.bdir[0] : 0, uy = m.bdir ? m.bdir[1] : 0;
    const l = Math.hypot(ux, uy);
    if (!(l > 0.2)) { const w = 1 / (s.along * s.perp); return [w, 0, 0, w]; } // Richtung unbekannt: rund
    ux /= l; uy /= l;
    const a = 1 / (s.along * s.along), p = 1 / (s.perp * s.perp);
    // a·u·uᵀ + p·(I − u·uᵀ)
    return [p + (a - p) * ux * ux, (a - p) * ux * uy, (a - p) * ux * uy, p + (a - p) * uy * uy];
  }
  function combine(list) {
    let A = [0, 0, 0, 0], bx = 0, by = 0;
    for (const m of list) {
      const I = info(m);
      A = A.map((v, i) => v + I[i]);
      bx += I[0] * m.x + I[1] * m.y;
      by += I[2] * m.x + I[3] * m.y;
    }
    const det = A[0] * A[3] - A[1] * A[2];
    if (!(Math.abs(det) > 1e-12)) return { x: list[0].x, y: list[0].y };
    return { x: (A[3] * bx - A[1] * by) / det, y: (-A[2] * bx + A[0] * by) / det };
  }

  // Treffer beider Kameras einander zuordnen. emit(dart, src) wird mit dem fertigen Pfeil aufgerufen.
  function createMatcher(o = {}) {
    const now = o.now || (() => Date.now());
    const WAIT = o.wait || 700;      // so lange wartet ein Treffer der Hauptkamera auf die 2. Kamera
    const ALONE = o.alone || 1100;   // Treffer nur der 2. Kamera (Hauptkamera verdeckt): nach dieser Zeit allein zählen
    const RADIUS = o.radius || 30;   // mm: weiter auseinander = verschiedene Pfeile
    let main = [], help = [];
    const emit = o.emit || (() => {});

    function finish(m, h) {
      const parts = [m, h].filter(Boolean);
      const p = parts.length > 1 ? combine(parts) : { x: parts[0].x, y: parts[0].y };
      const d = Board.score(p.x, p.y);
      d.x = p.x; d.y = p.y; d.auto = true;
      if (m && m.bdir) d.bdir = m.bdir;
      if (parts.length > 1) d.fused = true;
      emit(d, m && h ? 'beide' : m ? 'haupt' : 'zweite', { main: m, help: h });
    }
    function tryPair() {
      for (const m of main.slice()) {
        let best = -1, bd = RADIUS;
        help.forEach((h, i) => { const dd = Math.hypot(h.x - m.x, h.y - m.y); if (dd < bd) { bd = dd; best = i; } });
        if (best >= 0) {
          const h = help.splice(best, 1)[0];
          main.splice(main.indexOf(m), 1);
          finish(m, h);
        }
      }
    }
    return {
      main(m) { main.push({ ...m, t: now() }); tryPair(); },
      help(h) { help.push({ ...h, t: now() }); tryPair(); },
      tick() {
        const t = now();
        for (const m of main.slice()) if (t - m.t >= WAIT) { main.splice(main.indexOf(m), 1); finish(m, null); }
        for (const h of help.slice()) if (t - h.t >= ALONE) { help.splice(help.indexOf(h), 1); if (o.allowAlone !== false) finish(null, h); }
      },
      reset() { main = []; help = []; },
      get pending() { return main.length + help.length; },
    };
  }

  return { sigma, info, combine, createMatcher };
});
