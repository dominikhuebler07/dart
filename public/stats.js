// Statistik: Würfe erfassen und auswerten (läuft im Browser und in den Tests)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./board.js'));
  else root.DartStats = factory(root.Board);
})(typeof self !== 'undefined' ? self : this, function (Board) {
  const MAX_HITS = 3000;    // Trefferpositionen für die Heatmap (neueste)
  const MAX_HISTORY = 60;   // gespeicherte Spiele
  const MAX_KEYS = 400;     // zuletzt erfasste Aufnahmen (gegen Doppelzählung)

  function empty() {
    return {
      v: 1,
      darts: 0, points: 0, turns: 0,
      f9Darts: 0, f9Points: 0,
      t180: 0, t140: 0, t100: 0, t60: 0, bestTurn: 0,
      dblAttempts: 0, dblHits: 0, checkouts: 0, bestCheckout: 0,
      games: 0, wins: 0, bestAvg: 0,
      fields: {},          // 'T20': 12, 'D16': 3, 'S5': 40, 'SB': 2, 'DB': 1, 'M': 7
      hits: [],            // flach: x1, y1, x2, y2 … in mm × 2 (ganzzahlig)
      history: [],         // [{t, avg, darts, won, mode, start}]
      keys: [],            // zuletzt erfasste Aufnahmen (Spiel-ID:Nummer)
      updated: 0,
    };
  }

  function fieldKey(d) {
    if (!d || !d.seg) return 'M';
    if (d.seg === 25) return d.mult === 2 ? 'DB' : 'SB';
    return (d.mult === 3 ? 'T' : d.mult === 2 ? 'D' : 'S') + d.seg;
  }

  function fieldLabel(k) {
    if (k === 'M') return 'Miss';
    if (k === 'SB') return '25';
    if (k === 'DB') return 'Bull';
    return k[0] === 'S' ? k.slice(1) : k;
  }

  // Eine Aufnahme (bis 3 Pfeile) erfassen.
  // turn: { darts, bust, startScore }, ctx: { key, doubleOut, legTurn (0 = erste Aufnahme im Leg) }
  function recordTurn(s, turn, ctx = {}) {
    if (ctx.key) {
      if (s.keys.includes(ctx.key)) return false;
      s.keys.push(ctx.key);
      if (s.keys.length > MAX_KEYS) s.keys.splice(0, s.keys.length - MAX_KEYS);
    }
    const darts = (turn.darts || []).filter((d) => !d.void);
    let rem = turn.startScore, scored = 0;
    for (const d of darts) {
      const k = fieldKey(d);
      s.fields[k] = (s.fields[k] || 0) + 1;
      if (Number.isFinite(d.x) && Number.isFinite(d.y) && d.auto) {
        s.hits.push(Math.round(d.x * 2), Math.round(d.y * 2));
      }
      // Doppelquote: Pfeil auf ein mögliches Finish mit einem Doppel
      if (ctx.doubleOut !== false && rem != null && !d.void) {
        if ((rem <= 40 && rem % 2 === 0 && rem > 0) || rem === 50) {
          s.dblAttempts++;
          if (rem - d.value === 0 && d.mult === 2) s.dblHits++;
        }
      }
      if (!d.void && rem != null) rem -= d.value;
      if (!d.void) scored += d.value;
    }
    if (s.hits.length > MAX_HITS * 2) s.hits.splice(0, s.hits.length - MAX_HITS * 2);
    const pts = turn.bust ? 0 : scored;
    s.darts += darts.length;
    s.points += pts;
    s.turns++;
    if (ctx.legTurn != null && ctx.legTurn < 3) { s.f9Darts += darts.length; s.f9Points += pts; }
    if (pts === 180) s.t180++;
    else if (pts >= 140) s.t140++;
    else if (pts >= 100) s.t100++;
    else if (pts >= 60) s.t60++;
    s.bestTurn = Math.max(s.bestTurn, pts);
    if (turn.won) {
      s.checkouts++;
      s.bestCheckout = Math.max(s.bestCheckout, turn.startScore);
    }
    s.updated = Date.now();
    return true;
  }

  // Ein Spiel abschließen. g: { key, avg, darts, won, mode, start }
  function recordGame(s, g) {
    if (g.key) {
      const k = 'G' + g.key;
      if (s.keys.includes(k)) return false;
      s.keys.push(k);
    }
    s.games++;
    if (g.won) s.wins++;
    if (g.darts >= 9) s.bestAvg = Math.max(s.bestAvg, Math.round(g.avg * 100) / 100);
    s.history.push({ t: g.t || Date.now(), avg: Math.round(g.avg * 100) / 100, darts: g.darts, won: !!g.won, mode: g.mode || 'local', start: g.start || 501 });
    if (s.history.length > MAX_HISTORY) s.history.splice(0, s.history.length - MAX_HISTORY);
    s.updated = Date.now();
    return true;
  }

  // Zwei Statistiken zusammenführen (z. B. Gast-Statistik ins Konto übernehmen)
  function merge(a, b) {
    const s = empty();
    for (const k of ['darts', 'points', 'turns', 'f9Darts', 'f9Points', 't180', 't140', 't100', 't60', 'dblAttempts', 'dblHits', 'checkouts', 'games', 'wins']) s[k] = (a[k] || 0) + (b[k] || 0);
    for (const k of ['bestTurn', 'bestCheckout', 'bestAvg']) s[k] = Math.max(a[k] || 0, b[k] || 0);
    for (const src of [a.fields || {}, b.fields || {}]) for (const k in src) s.fields[k] = (s.fields[k] || 0) + src[k];
    s.hits = [...(a.hits || []), ...(b.hits || [])].slice(-MAX_HITS * 2);
    s.history = [...(a.history || []), ...(b.history || [])].sort((x, y) => x.t - y.t).slice(-MAX_HISTORY);
    s.keys = [...new Set([...(a.keys || []), ...(b.keys || [])])].slice(-MAX_KEYS);
    s.updated = Date.now();
    return s;
  }

  // Abgeleitete Kennzahlen für die Anzeige
  function summary(s) {
    const avg = s.darts ? (s.points / s.darts) * 3 : 0;
    const f9 = s.f9Darts ? (s.f9Points / s.f9Darts) * 3 : 0;
    // Segmente 1–20 (alle Ringe zusammen), Ringe gesamt
    const seg = {}, rings = { S: 0, D: 0, T: 0, SB: 0, DB: 0, M: 0 };
    let total = 0;
    for (const k in s.fields) {
      const n = s.fields[k];
      total += n;
      if (k === 'M' || k === 'SB' || k === 'DB') rings[k] += n;
      else { rings[k[0]] += n; const num = +k.slice(1); seg[num] = (seg[num] || 0) + n; }
    }
    const top = Object.entries(s.fields).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, n]) => ({ key: k, label: fieldLabel(k), n, pct: total ? n / total : 0 }));
    return {
      avg, f9, darts: s.darts, games: s.games, wins: s.wins,
      winPct: s.games ? s.wins / s.games : 0,
      dblPct: s.dblAttempts ? s.dblHits / s.dblAttempts : 0,
      dblAttempts: s.dblAttempts, dblHits: s.dblHits,
      t180: s.t180, t140: s.t140, t100: s.t100, t60: s.t60, bestTurn: s.bestTurn,
      bestCheckout: s.bestCheckout, checkouts: s.checkouts, bestAvg: s.bestAvg,
      seg, rings, total, top, history: s.history,
    };
  }

  // Eintrag für die Weltrangliste
  function leaderboardEntry(s, name, photo) {
    const sm = summary(s);
    const avg = Math.round(sm.avg * 100) / 100;
    return {
      name: String(name || 'Spieler').slice(0, 24),
      photo: photo || '',
      avg, darts: s.darts, games: s.games, wins: s.wins,
      t180: s.t180, bestCheckout: s.bestCheckout, bestAvg: s.bestAvg,
      // nur mit genug Pfeilen in der Average-Wertung (sonst reicht eine Glücksaufnahme)
      rankAvg: s.darts >= 99 ? avg : 0,
    };
  }

  return { empty, fieldKey, fieldLabel, recordTurn, recordGame, merge, summary, leaderboardEntry, MAX_HITS };
});
