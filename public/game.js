// Spiellogik X01 (301/501/701) – läuft im Browser (lokal) und auf dem Server (online)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DartGame = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const START_SCORES = [301, 501, 701];

  function newTurn(startScore) {
    return { startScore, darts: [], bust: false, won: false };
  }

  function clean(d) {
    let seg = Math.round(Number(d && d.seg));
    let mult = Math.round(Number(d && d.mult));
    if (!(seg >= 1 && seg <= 20) && seg !== 25) { seg = 0; mult = 0; }
    if (seg === 25 && mult !== 2) mult = 1;
    if (seg >= 1 && seg <= 20 && !(mult >= 1 && mult <= 3)) mult = 1;
    const out = { seg, mult, value: seg * mult };
    if (d && Number.isFinite(d.x) && Number.isFinite(d.y)) {
      out.x = Math.round(d.x * 10) / 10;
      out.y = Math.round(d.y * 10) / 10;
    }
    if (d && d.auto) out.auto = true;
    return out;
  }

  function create(players, opts = {}) {
    const start = START_SCORES.includes(Number(opts.startScore)) ? Number(opts.startScore) : 501;
    const g = {
      id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4),
      startScore: start,
      doubleOut: opts.doubleOut !== false,
      players: players.map((p) => ({ id: p.id, name: p.name, score: start, history: [], legs: p.legs || 0 })),
      starter: opts.starter || 0,
      current: 0,
      turn: null,
      turnId: 1,
      finished: false,
      winner: null,
    };
    g.current = g.starter % g.players.length;
    g.turn = newTurn(start);
    return g;
  }

  function recompute(g) {
    const t = g.turn;
    const p = g.players[g.current];
    let rem = t.startScore;
    t.bust = false;
    t.won = false;
    for (const d of t.darts) {
      if (t.bust || t.won) { d.void = true; continue; }
      d.void = false;
      const n = rem - d.value;
      if (n < 0 || (g.doubleOut && n === 1) || (n === 0 && g.doubleOut && d.mult !== 2)) {
        t.bust = true;
        continue;
      }
      rem = n;
      if (rem === 0) t.won = true;
    }
    p.score = t.bust ? t.startScore : rem;
    g.finished = t.won;
    g.winner = t.won ? p.id : null;
  }

  function turnComplete(g) {
    const t = g.turn;
    return t.bust || t.won || t.darts.length >= 3;
  }

  function addDart(g, d) {
    if (g.finished || turnComplete(g)) return false;
    g.turn.darts.push(clean(d));
    recompute(g);
    return true;
  }

  function setDart(g, i, d) {
    if (!(i >= 0 && i < g.turn.darts.length)) return false;
    g.turn.darts[i] = clean(d);
    recompute(g);
    return true;
  }

  function removeDart(g, i) {
    if (!(i >= 0 && i < g.turn.darts.length)) return false;
    g.turn.darts.splice(i, 1);
    recompute(g);
    return true;
  }

  function next(g) {
    if (g.finished) return false;
    const t = g.turn;
    const p = g.players[g.current];
    p.history.push({ darts: t.darts, bust: t.bust, scored: t.bust ? 0 : t.startScore - p.score });
    g.current = (g.current + 1) % g.players.length;
    g.turn = newTurn(g.players[g.current].score);
    g.turnId++;
    return true;
  }

  function undo(g) {
    if (g.turn.darts.length) {
      g.turn.darts.pop();
      recompute(g);
      return true;
    }
    const prev = (g.current - 1 + g.players.length) % g.players.length;
    const p = g.players[prev];
    const h = p.history.pop();
    if (!h) return false;
    g.current = prev;
    g.turn = newTurn(h.bust ? p.score : p.score + h.scored);
    g.turn.darts = h.darts;
    g.turn.darts.pop();
    g.turnId++;
    recompute(g);
    return true;
  }

  // Einen Pfeil korrigieren. Ist die aktuelle Aufnahme noch leer (z. B. schon automatisch weitergeschaltet),
  // wird die vorherige Aufnahme korrigiert. index: 0–2 oder null = letzter Pfeil.
  function correct(g, index, d) {
    if (g.turn.darts.length) {
      const i = index == null ? g.turn.darts.length - 1 : index;
      return setDart(g, i, d) ? 'current' : false;
    }
    const prev = (g.current - 1 + g.players.length) % g.players.length;
    const p = g.players[prev];
    const h = p.history[p.history.length - 1];
    if (!h || !h.darts.length) return false;
    const i = index == null ? h.darts.length - 1 : index;
    if (!(i >= 0 && i < h.darts.length)) return false;
    p.history.pop();
    g.current = prev;
    g.turn = newTurn(h.bust ? p.score : p.score + h.scored);
    g.turn.darts = h.darts.map((x) => ({ ...x }));
    g.turn.darts[i] = clean(d);
    g.turnId++;
    recompute(g);
    if (!g.finished && turnComplete(g)) next(g);
    return 'previous';
  }

  function rematch(g) {
    const players = g.players.map((p) => ({ id: p.id, name: p.name, legs: p.legs + (p.id === g.winner ? 1 : 0) }));
    return create(players, { startScore: g.startScore, doubleOut: g.doubleOut, starter: (g.starter + 1) % players.length });
  }

  function stats(g, idx) {
    const p = g.players[idx];
    let darts = 0;
    for (const h of p.history) darts += h.darts.length;
    if (idx === g.current) darts += g.turn.darts.length;
    const scored = g.startScore - p.score;
    return { darts, avg: darts ? (scored / darts) * 3 : 0 };
  }

  // ---------- Checkout-Vorschläge ----------
  const FINAL_PREF = [20, 16, 18, 12, 10, 8, 14, 6, 4, 2, 19, 17, 15, 13, 11, 9, 7, 5, 3, 1, 25];
  const SETUP = [];
  for (let n = 20; n >= 1; n--) SETUP.push({ seg: n, mult: 3, value: 3 * n, cost: n >= 19 ? 1.5 : 2.5 });
  for (let n = 20; n >= 1; n--) SETUP.push({ seg: n, mult: 1, value: n, cost: 1 });
  SETUP.push({ seg: 25, mult: 1, value: 25, cost: 3 });
  SETUP.push({ seg: 25, mult: 2, value: 50, cost: 4 });
  for (let n = 20; n >= 1; n--) SETUP.push({ seg: n, mult: 2, value: 2 * n, cost: 3 });
  const cache = new Map();

  function lbl(d) {
    if (d.seg === 25) return d.mult === 2 ? 'Bull' : '25';
    return (d.mult === 3 ? 'T' : d.mult === 2 ? 'D' : '') + d.seg;
  }

  function checkout(rem, dartsLeft, doubleOut) {
    if (rem <= 0 || dartsLeft <= 0 || rem > 180) return null;
    const key = rem + ':' + dartsLeft + ':' + (doubleOut ? 1 : 0);
    if (cache.has(key)) return cache.get(key);
    const finals = doubleOut
      ? FINAL_PREF.map((n, i) => ({ seg: n, mult: 2, value: n * 2, cost: i * 0.6 }))
      : SETUP.map((d) => ({ ...d }));
    let best = null;
    const consider = (combo) => {
      const c = combo.reduce((s, d) => s + d.cost, 0) + combo.length * 10;
      if (!best || c < best.c) best = { c, combo };
    };
    for (const f of finals) {
      if (f.value === rem) consider([f]);
      if (dartsLeft >= 2) for (const a of SETUP) if (a.value + f.value === rem) consider([a, f]);
    }
    if (!best && dartsLeft >= 3) {
      for (const f of finals) for (const a of SETUP) {
        const r2 = rem - f.value - a.value;
        if (r2 <= 0) continue;
        for (const b of SETUP) if (b.value === r2) consider([a, b, f]);
      }
    }
    const out = best ? best.combo.map(lbl) : null;
    cache.set(key, out);
    return out;
  }

  return { START_SCORES, create, addDart, setDart, removeDart, next, undo, correct, rematch, turnComplete, stats, checkout, clean };
});
