// Lernmodus: vom Anfänger zum Profi. Reine Logik (läuft im Browser und in den Tests).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Learn = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const STAGES = [
    { id: 1, name: 'Anfänger', sub: 'Die Grundlagen' },
    { id: 2, name: 'Fortgeschritten', sub: 'Sicher werden' },
    { id: 3, name: 'Könner', sub: 'Triple & Doppel' },
    { id: 4, name: 'Experte', sub: 'Konstant punkten' },
    { id: 5, name: 'Profi', sub: 'Wie im Fernsehen' },
  ];
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

  // stars: drei Schwellen [bestanden, 2 Sterne, 3 Sterne]; lower = true heißt "weniger ist besser" (Pfeile)
  const LESSONS = [
    { id: 'a1', stage: 1, title: 'Die Scheibe treffen', type: 'hits', target: { any: true }, darts: 15, stars: [10, 12, 14],
      goal: 'Triff mit 15 Pfeilen mindestens 10-mal die Scheibe.',
      coach: ['Stell dich seitlich: die Fußspitze des Wurfbeins an die Abwurflinie, Gewicht leicht nach vorne.', 'Halte den Pfeil locker mit drei Fingern – so fest wie einen Stift.', 'Nur der Unterarm bewegt sich, der Ellbogen bleibt ruhig an seinem Platz.'] },
    { id: 'a2', stage: 1, title: 'Große Felder: die 20', type: 'hits', target: { seg: 20 }, darts: 15, stars: [4, 6, 8],
      goal: 'Ziel ist das ganze 20er-Feld. Mindestens 4 Treffer mit 15 Pfeilen.',
      coach: ['Schau nur auf dein Ziel, nicht auf den Pfeil.', 'Gleicher Ablauf bei jedem Wurf: ausholen, kurz stoppen, werfen.', 'Lass den Arm nach dem Wurf in Richtung Ziel ausschwingen.'] },
    { id: 'a3', stage: 1, title: 'Rund um die Uhr 1–10', type: 'atc', seq: range(1, 10), max: 60, stars: [60, 40, 28], lower: true,
      goal: 'Triff die Zahlen 1 bis 10 der Reihe nach – Single, Doppel oder Triple zählen. Höchstens 60 Pfeile.',
      coach: ['Jede Zahl ist ein neues Ziel – kurz neu ausrichten, dann werfen.', 'Wirf nicht schneller, nur weil es nicht klappt: Rhythmus schlägt Tempo.'] },

    { id: 'f1', stage: 2, title: 'Rund um die Uhr 1–20', type: 'atc', seq: range(1, 20), max: 90, stars: [90, 65, 45], lower: true,
      goal: 'Alle Zahlen von 1 bis 20 der Reihe nach, höchstens 90 Pfeile.',
      coach: ['Für Zahlen links (11, 14, 8) leicht die Schulter mitdrehen, nicht den ganzen Körper.', 'Bleib im Stand stabil – das Kippen nach vorne verreißt die Pfeile.'] },
    { id: 'f2', stage: 2, title: 'Punkte sammeln', type: 'score', rounds: 10, stars: [30, 38, 45],
      goal: 'Wirf 10 Aufnahmen auf die 20 und erreiche einen Durchschnitt von mindestens 30 Punkten.',
      coach: ['Ziel ist die Mitte der 20 – auch ein Single 20 sind wertvolle Punkte.', 'Die Gruppierung zählt: drei Pfeile nah beieinander sind besser als ein Zufallstreffer.'] },
    { id: 'f3', stage: 2, title: 'Erste Doppel', type: 'hits', target: { mult: 2 }, darts: 30, stars: [3, 5, 8],
      goal: 'Triff mit 30 Pfeilen mindestens 3 Doppel (jedes Doppel und das Bull zählen).',
      coach: ['Ziel auf die Innenkante des Doppelrings – geht der Pfeil etwas zu tief, landet er noch im Single.', 'Doppel 20, 16 und 8 sind die beliebtesten Finish-Felder – üb sie am meisten.'] },

    { id: 'k1', stage: 3, title: 'Triple 20 Training', type: 'hits', target: { seg: 20, mult: 3 }, darts: 30, stars: [3, 5, 8],
      goal: 'Mindestens 3 Triple 20 mit 30 Pfeilen.',
      coach: ['Wenn der erste Pfeil im Weg steckt: leicht versetzt auf die T20 zielen statt aufzugeben.', 'Ruhig atmen, vor dem Wurf kurz ausatmen.'] },
    { id: 'k2', stage: 3, title: 'Scoring Ø 45', type: 'score', rounds: 10, stars: [45, 52, 60],
      goal: '10 Aufnahmen auf die 20 mit einem Durchschnitt von mindestens 45.',
      coach: ['Bleibt der Pfeil links der 20 hängen, trifft er die 5 – lieber minimal rechts zielen (Richtung 1).', 'Gleiche Griffposition bei jedem Pfeil – der Schwerpunkt entscheidet.'] },
    { id: 'k3', stage: 3, title: 'Lieblingsdoppel', type: 'checkout', starts: [40, 32, 40, 32, 40, 32, 40, 32, 40, 32], stars: [3, 5, 7],
      goal: '10 Versuche mit je 3 Pfeilen: 40 (D20) und 32 (D16) auschecken. Mindestens 3 schaffen.',
      coach: ['Triffst du bei 40 die Single 20, bleibt 20 – dann auf D10.', 'Bei 32 kommst du über Single 16 auf D8, über Single 8 auf D12 – merk dir diese Wege.'] },

    { id: 'e1', stage: 4, title: 'Bull-Training', type: 'hits', target: { seg: 25 }, darts: 30, stars: [5, 8, 11],
      goal: 'Mindestens 5 Treffer ins Bull oder Single-Bull (25) mit 30 Pfeilen.',
      coach: ['Das Bull ist klein – zieh die Wurfbewegung gerade durch, ohne Drehung im Handgelenk.', 'Die Augen bleiben auf dem Ziel, bis der Pfeil steckt.'] },
    { id: 'e2', stage: 4, title: 'Scoring Ø 60', type: 'score', rounds: 10, stars: [60, 68, 76],
      goal: '10 Aufnahmen mit einem Durchschnitt von mindestens 60.',
      coach: ['Schlechte Aufnahme? Sofort abhaken – die nächste beginnt bei null.', 'Wenn die 20 blockiert ist: Wechsel auf die 19 und gruppieren.'] },
    { id: 'e3', stage: 4, title: 'Checkouts bis 60', type: 'checkout', starts: [41, 50, 36, 57, 48, 60, 44, 52, 38, 56], stars: [3, 5, 7],
      goal: '10 Rest-Werte bis 60, je 3 Pfeile. Mindestens 3 Checkouts.',
      coach: ['Erst rechnen, dann werfen: Welches Single bringt mich auf mein Lieblingsdoppel?', 'Die Finish-Vorschläge oben zeigen dir den besten Weg.'] },

    { id: 'p1', stage: 5, title: 'Scoring Ø 75', type: 'score', rounds: 10, stars: [75, 85, 95],
      goal: '10 Aufnahmen mit einem Durchschnitt von mindestens 75 – Kneipen-Profi-Niveau.',
      coach: ['Auf diesem Niveau entscheidet die Wiederholbarkeit: gleicher Stand, gleicher Griff, gleicher Rhythmus.'] },
    { id: 'p2', stage: 5, title: 'Große Finishes', type: 'checkout', starts: [81, 100, 76, 90, 85, 96, 70, 84, 98, 60], stars: [2, 4, 6],
      goal: '10 große Rest-Werte (60–100), je 3 Pfeile. Mindestens 2 Checkouts.',
      coach: ['Bei 100: T20, D20. Bei 81: T19, D12. Lerne die Standardwege auswendig.', 'Geht der Triple daneben, plane sofort den neuen Weg.'] },
    { id: 'p3', stage: 5, title: 'Profi-Prüfung: 501', type: 'x01', start: 501, max: 24, stars: [24, 18, 15], lower: true,
      goal: 'Spiel 501 mit Double-Out in höchstens 24 Pfeilen (Ø über 62).',
      coach: ['Das ist die Abschlussprüfung. Ruhig bleiben, wie im Training.', 'Ein 9-Darter wäre perfekt – 18 Pfeile reichen für 2 Sterne.'] },
  ];
  const byId = Object.fromEntries(LESSONS.map((l) => [l.id, l]));

  // ---------- Hilfen ----------
  const lbl = (d) => (!d || !d.seg ? 'Miss' : d.seg === 25 ? (d.mult === 2 ? 'Bull' : '25') : (d.mult === 3 ? 'T' : d.mult === 2 ? 'D' : '') + d.seg);
  function clean(d) {
    let seg = Math.round(Number(d && d.seg)), mult = Math.round(Number(d && d.mult));
    if (!(seg >= 1 && seg <= 20) && seg !== 25) { seg = 0; mult = 0; }
    if (seg === 25 && mult !== 2) mult = 1;
    if (seg >= 1 && seg <= 20 && !(mult >= 1 && mult <= 3)) mult = 1;
    const o = { seg, mult, value: seg * mult };
    if (d && Number.isFinite(d.x) && Number.isFinite(d.y)) { o.x = d.x; o.y = d.y; }
    if (d && d.auto) o.auto = true;
    return o;
  }
  function hit(target, d) {
    if (!d.seg) return false;
    if (target.any) return true;
    if (target.seg != null && d.seg !== target.seg) return false;
    if (target.mult != null && d.mult !== target.mult) return false;
    return true;
  }
  function targetLabel(t) {
    if (t.any) return 'Scheibe';
    if (t.seg === 25) return 'Bull / 25';
    if (t.seg != null && t.mult === 3) return 'Triple ' + t.seg;
    if (t.seg != null && t.mult === 2) return 'Doppel ' + t.seg;
    if (t.seg != null) return t.seg + 'er-Feld';
    if (t.mult === 2) return 'Doppel';
    if (t.mult === 3) return 'Triple';
    return '?';
  }
  function starsFor(L, v) {
    const s = L.stars;
    if (L.lower) return v <= s[2] ? 3 : v <= s[1] ? 2 : v <= s[0] ? 1 : 0;
    return v >= s[2] ? 3 : v >= s[1] ? 2 : v >= s[0] ? 1 : 0;
  }

  // ---------- Sitzung ----------
  // rounds: abgeschlossene Aufnahmen (je bis zu 3 Pfeile), cur: laufende Aufnahme. Alles andere wird nachgerechnet.
  function create(id) {
    const L = byId[id];
    if (!L) return null;
    const s = { id, rounds: [], cur: [], st: null };
    replay(s);
    return s;
  }

  function replay(s) {
    const L = byId[s.id];
    const all = [...s.rounds.map((r) => ({ darts: r, closed: true })), { darts: s.cur, closed: false }];
    const st = { darts: 0, finished: false, passed: false, value: 0, stars: 0, curDone: false, info: {} };
    if (L.type === 'hits') {
      let hits = 0;
      for (const r of all) for (const d of r.darts) { st.darts++; if (hit(L.target, d)) hits++; }
      st.value = hits;
      st.finished = st.darts >= L.darts;
      st.curDone = s.cur.length >= 3 || st.finished;
      st.target = targetLabel(L.target);
      st.progress = Math.min(1, st.darts / L.darts);
      st.metric = `${hits} Treffer · ${Math.max(0, L.darts - st.darts)} Pfeile übrig`;
      st.need = `Ziel: ${L.stars[0]} Treffer`;
    } else if (L.type === 'atc') {
      let pos = 0;
      for (const r of all) for (const d of r.darts) {
        if (pos >= L.seq.length) break;
        st.darts++;
        if (d.seg === L.seq[pos]) pos++;
      }
      st.value = st.darts;
      st.finished = pos >= L.seq.length || st.darts >= L.max;
      st.passedRun = pos >= L.seq.length;
      st.curDone = s.cur.length >= 3 || st.finished;
      st.target = pos < L.seq.length ? String(L.seq[pos]) : '✓';
      st.progress = pos / L.seq.length;
      st.metric = `${pos}/${L.seq.length} geschafft · ${st.darts} Pfeile`;
      st.need = `Höchstens ${L.max} Pfeile`;
      st.info.pos = pos;
    } else if (L.type === 'score') {
      let pts = 0, n = 0, done = 0;
      for (const r of all) { for (const d of r.darts) { pts += d.value; n++; } if (r.closed || r.darts.length >= 3) done++; }
      const fullRounds = Math.min(L.rounds, s.rounds.length + (s.cur.length >= 3 ? 1 : 0));
      st.darts = n;
      st.value = n ? Math.round((pts / n) * 3 * 10) / 10 : 0;
      st.finished = fullRounds >= L.rounds;
      st.curDone = s.cur.length >= 3;
      st.target = '20';
      st.progress = fullRounds / L.rounds;
      st.metric = `Aufnahme ${Math.min(L.rounds, s.rounds.length + 1)}/${L.rounds} · Ø ${String(st.value).replace('.', ',')}`;
      st.need = `Ziel: Ø ${L.stars[0]}`;
    } else if (L.type === 'checkout') {
      let ok = 0;
      const res = [];
      all.forEach((r, i) => {
        if (i >= L.starts.length) return;
        let rest = L.starts[i], out = null;
        for (const d of r.darts) {
          st.darts++;
          const n = rest - d.value;
          if (n < 0 || n === 1 || (n === 0 && d.mult !== 2)) { out = 'bust'; break; }
          rest = n;
          if (rest === 0) { out = 'ok'; ok++; break; }
        }
        if (!out && r.darts.length >= 3) out = 'fail';
        res.push({ start: L.starts[i], rest, out });
      });
      const cur = res[s.rounds.length] || null;
      st.value = ok;
      st.results = res;
      st.curDone = !!(cur && cur.out);
      st.finished = s.rounds.length + (st.curDone ? 1 : 0) >= L.starts.length;
      st.rest = cur ? cur.rest : null;
      st.target = cur ? String(cur.rest) : '✓';
      st.progress = Math.min(1, (s.rounds.length + (st.curDone ? 1 : 0)) / L.starts.length);
      st.metric = `Versuch ${Math.min(L.starts.length, s.rounds.length + 1)}/${L.starts.length} · ${ok} Checkouts`;
      st.need = `Ziel: ${L.stars[0]} Checkouts`;
      st.info.dartsLeft = 3 - s.cur.length;
    } else if (L.type === 'x01') {
      let rest = L.start, won = false;
      for (const r of all) {
        const turnStart = rest;
        let bust = false;
        for (const d of r.darts) {
          if (won) break;
          st.darts++;
          const n = rest - d.value;
          if (n < 0 || n === 1 || (n === 0 && d.mult !== 2)) { bust = true; break; }
          rest = n;
          if (rest === 0) won = true;
        }
        if (bust) rest = turnStart;
        if (!r.closed) st.curBust = bust;
      }
      st.rest = rest;
      st.value = st.darts;
      st.passedRun = won && st.darts <= L.max;
      st.finished = won || st.darts >= L.max;
      st.curDone = s.cur.length >= 3 || won || st.curBust || st.finished;
      st.target = String(rest);
      st.progress = (L.start - rest) / L.start;
      st.metric = `Rest ${rest} · ${st.darts}/${L.max} Pfeile`;
      st.need = `Höchstens ${L.max} Pfeile`;
      st.info.dartsLeft = 3 - s.cur.length;
    }
    if (st.finished) {
      if (L.type === 'atc' || L.type === 'x01') st.stars = st.passedRun ? starsFor(L, st.value) : 0;
      else st.stars = starsFor(L, st.value);
      st.passed = st.stars > 0;
    }
    s.st = st;
    return st;
  }

  function addDart(s, d) {
    if (s.st.finished || s.st.curDone) return false;
    s.cur.push(clean(d));
    replay(s);
    return true;
  }
  function setDart(s, i, d) {
    if (!(i >= 0 && i < s.cur.length)) return false;
    s.cur[i] = clean(d);
    replay(s);
    return true;
  }
  function undo(s) {
    if (s.cur.length) s.cur.pop();
    else if (s.rounds.length) { s.cur = s.rounds.pop(); s.cur.pop(); }
    else return false;
    replay(s);
    return true;
  }
  // Aufnahme abschließen (Pfeile gezogen)
  function next(s) {
    if (!s.cur.length || s.st.finished) return false;
    s.rounds.push(s.cur);
    s.cur = [];
    replay(s);
    return true;
  }
  function resultText(s) {
    const L = byId[s.id], st = s.st;
    if (L.type === 'hits') return `${st.value} Treffer mit ${L.darts} Pfeilen`;
    if (L.type === 'atc') return st.passedRun ? `Geschafft in ${st.value} Pfeilen` : `${st.info.pos}/${L.seq.length} Zahlen in ${L.max} Pfeilen`;
    if (L.type === 'score') return `Durchschnitt ${String(st.value).replace('.', ',')}`;
    if (L.type === 'checkout') return `${st.value} von ${L.starts.length} Checkouts`;
    if (L.type === 'x01') return st.passedRun ? `501 in ${st.value} Pfeilen` : `Rest ${st.rest} nach ${st.darts} Pfeilen`;
    return '';
  }

  // ---------- Fortschritt ----------
  // progress: { [lessonId]: { stars, best, tries } }
  function unlocked(progress, id) {
    const i = LESSONS.findIndex((l) => l.id === id);
    if (i <= 0) return i === 0;
    const prev = progress[LESSONS[i - 1].id];
    return !!(prev && prev.stars > 0);
  }
  function record(progress, id, st) {
    const L = byId[id];
    const p = progress[id] || { stars: 0, best: null, tries: 0 };
    p.tries++;
    p.stars = Math.max(p.stars, st.stars || 0);
    if (st.passed || L.type === 'hits' || L.type === 'score' || L.type === 'checkout') {
      const better = p.best == null || (L.lower ? st.value < p.best : st.value > p.best);
      if (better && (!L.lower || st.passed)) p.best = st.value;
    }
    progress[id] = p;
    return p;
  }
  function level(progress) {
    let lvl = 0;
    for (const S of STAGES) {
      if (LESSONS.filter((l) => l.stage === S.id).every((l) => progress[l.id] && progress[l.id].stars > 0)) lvl = S.id;
      else break;
    }
    return lvl; // 0 = noch keine Stufe abgeschlossen
  }
  function totalStars(progress) { return LESSONS.reduce((a, l) => a + ((progress[l.id] && progress[l.id].stars) || 0), 0); }

  return { STAGES, LESSONS, byId, create, replay, addDart, setDart, undo, next, resultText, unlocked, record, level, totalStars, targetLabel, label: lbl };
});
