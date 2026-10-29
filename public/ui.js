// Statistik, Weltrangliste, Profil/Anmeldung, Navigation
(() => {
  'use strict';
  const DS = window.DS, S = window.DartStats, B = window.Board, Game = window.DartGame;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const esc = DS.esc, LS = DS.LS;
  const acct = () => window.Account || { available: false, user: null };
  const num = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d).replace('.', ',') : '–');
  const pct = (v) => (Number.isFinite(v) ? Math.round(v * 100) + ' %' : '–');

  // ================= Statistik speichern & synchronisieren =================
  let user = null;
  const keyFor = () => 'ds.stats.' + (user ? user.uid : 'guest');
  const load = (k = keyFor()) => { const s = LS.get(k, null); return s && s.v ? Object.assign(S.empty(), s) : S.empty(); };
  let stats = load();
  let sync = { state: 'local', msg: '' };

  function save() {
    LS.set(keyFor(), stats);
    scheduleCloud();
    if (current === 'stats') renderStats();
  }
  let cloudTimer = null;
  function scheduleCloud() {
    if (!user || !acct().available) return;
    clearTimeout(cloudTimer);
    sync = { state: 'pending', msg: '' };
    cloudTimer = setTimeout(pushCloud, 2500);
  }
  async function pushCloud() {
    try {
      await acct().saveStats(stats);
      await acct().saveLeaderboard(S.leaderboardEntry(stats, user.name, user.photo));
      sync = { state: 'ok', msg: '' };
    } catch (e) {
      sync = { state: 'error', msg: e.message };
    }
    if (current === 'profile') renderProfile();
  }

  async function onAccount(u) {
    const changed = (u && u.uid) !== (user && user.uid);
    user = u || null;
    renderChip();
    if (changed) {
      stats = load();
      if (user && acct().available) {
        sync = { state: 'pending', msg: 'Lade Statistik …' };
        try {
          const cloud = await acct().loadStats();
          if (cloud && (cloud.updated || 0) >= (stats.updated || 0)) stats = Object.assign(S.empty(), cloud);
          // Würfe, die vorher ohne Anmeldung auf diesem Gerät gespielt wurden, ins Konto übernehmen
          const guest = load('ds.stats.guest');
          if (guest.darts > 0) {
            stats = S.merge(stats, guest);
            LS.del('ds.stats.guest');
            DS.toast('Deine bisherigen Würfe wurden in dein Konto übernommen ✓');
          }
          LS.set(keyFor(), stats);
          await pushCloud();
        } catch (e) {
          sync = { state: 'error', msg: e.message };
        }
      }
    }
    renderCurrent();
  }
  window.addEventListener('account', (e) => onAccount(e.detail));
  if (window.Account) onAccount(window.Account.user);

  // ---------- Würfe aus dem Spiel erfassen ----------
  function track(g) {
    const me = DS.meIndex();
    if (me < 0 || DS.mode === 'test' || !g) return;
    if (!g.id) g.id = Math.random().toString(36).slice(2, 12);
    const p = g.players[me];
    let rem = g.startScore, changed = false;
    p.history.forEach((h, i) => {
      const start = rem;
      rem -= h.bust ? 0 : h.scored;
      if (S.recordTurn(stats, { darts: h.darts, bust: h.bust, startScore: start }, { key: `${g.id}:${me}:${i}`, doubleOut: g.doubleOut, legTurn: i })) changed = true;
    });
    if (g.finished) {
      if (g.winner === p.id && g.current === me) {
        const t = g.turn;
        if (S.recordTurn(stats, { darts: t.darts, bust: false, won: true, startScore: t.startScore }, { key: `${g.id}:${me}:F`, doubleOut: g.doubleOut, legTurn: p.history.length })) changed = true;
      }
      const st = Game.stats(g, me);
      if (S.recordGame(stats, { key: `${g.id}:${me}`, avg: st.avg, darts: st.darts, won: g.winner === p.id, mode: DS.mode, start: g.startScore })) changed = true;
    }
    if (changed) save();
  }
  DS.hooks.update.push(track);

  // ================= Navigation =================
  let current = 'home';
  DS.hooks.show.push((name) => { current = name; if (name === 'home') renderHomeStats(); });
  $('#tabbar').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    const tab = b.dataset.tab;
    if (tab === 'home') {
      if (DS.mode === 'online' && DS.room) DS.show(DS.game ? 'game' : 'lobby');
      else { DS.renderHome(); DS.show('home'); }
      return;
    }
    DS.show(tab);
    renderCurrent();
  });
  $('#acct-chip').onclick = () => { DS.show('profile'); renderProfile(); };

  function renderCurrent() {
    if (current === 'stats') renderStats();
    else if (current === 'rank') renderRank();
    else if (current === 'profile') renderProfile();
    else if (current === 'home') renderHomeStats();
  }

  function renderChip() {
    const a = $('#acct-avatar');
    if (user) {
      a.innerHTML = user.photo ? `<img src="${esc(user.photo)}" alt="" referrerpolicy="no-referrer">` : esc(user.name.slice(0, 1).toUpperCase());
      $('#acct-name').textContent = user.name.split(' ')[0];
    } else {
      a.textContent = '';
      $('#acct-name').textContent = acct().available ? 'Anmelden' : 'Profil';
    }
    $('#acct-chip').classList.toggle('signed', !!user);
  }

  // ================= Startseite =================
  function heroBoard() {
    const R = B.R;
    let s = '';
    for (let i = 0; i < 20; i++) {
      const [x1, y1] = B.polar(R.bullOut, i * 18 - 9), [x2, y2] = B.polar(R.doubleOut, i * 18 - 9);
      s += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" class="wire"/>`;
    }
    for (let i = 0; i < 20; i++) {
      const col = i % 2 === 0 ? 'r' : 'g';
      s += `<path d="${arc(R.doubleIn, R.doubleOut, i * 18 - 9, i * 18 + 9)}" class="${col}"/>`;
      s += `<path d="${arc(R.trebleIn, R.trebleOut, i * 18 - 9, i * 18 + 9)}" class="${col}"/>`;
    }
    for (const r of [R.bullOut, R.trebleIn, R.trebleOut, R.doubleIn, R.doubleOut, 192]) s += `<circle r="${r}" class="wire"/>`;
    s += `<circle r="${R.bullOut}" class="g"/><circle r="${R.bullIn}" class="r"/>`;
    $('#hero-board').innerHTML = `<g class="spin">${s}</g>`;
  }
  heroBoard();

  function renderHomeStats() {
    const el = $('#home-stats');
    if (!stats.darts) { el.classList.add('hidden'); return; }
    const sm = S.summary(stats);
    el.classList.remove('hidden');
    el.innerHTML = `<button class="home-stats-btn" id="home-stats-btn">
      <span class="k"><b>${num(sm.avg)}</b><small>Average</small></span>
      <span class="k"><b>${num(sm.f9)}</b><small>First 9</small></span>
      <span class="k"><b>${pct(sm.dblPct)}</b><small>Doppelquote</small></span>
      <span class="go">Deine Statistik</span></button>`;
    $('#home-stats-btn').onclick = () => { DS.show('stats'); renderStats(); };
  }
  DS.hooks.home.push(renderHomeStats);
  renderHomeStats();

  // ================= Statistik-Seite =================
  let boardMode = LS.get('ds.statsBoard', 'heat');

  function arc(r1, r2, a1, a2) {
    const f = (p) => p[0].toFixed(2) + ' ' + p[1].toFixed(2);
    return `M${f(B.polar(r2, a1))}A${r2} ${r2} 0 0 1 ${f(B.polar(r2, a2))}L${f(B.polar(r1, a2))}A${r1} ${r1} 0 0 0 ${f(B.polar(r1, a1))}Z`;
  }

  // Farbskala für Häufigkeiten: Graphit -> Board-Rot -> Sisal
  function ramp(t) {
    const stops = [[38, 42, 48], [140, 34, 30], [229, 50, 43], [236, 224, 191]];
    const x = Math.max(0, Math.min(1, t)) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
    const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
    return `rgb(${c.join(',')})`;
  }

  function fieldsSvg(sm) {
    const R = B.R, f = stats.fields, total = sm.total || 1;
    let max = 0;
    for (const k in f) if (k !== 'M') max = Math.max(max, f[k]);
    const share = (k) => (f[k] || 0) / (max || 1);
    const tipAttr = (k) => `data-k="${k}" data-n="${f[k] || 0}" data-p="${Math.round(((f[k] || 0) / total) * 1000) / 10}"`;
    let s = '';
    B.ORDER.forEach((n, i) => {
      const a1 = i * 18 - 9, a2 = i * 18 + 9;
      s += `<path d="${arc(R.doubleIn, R.doubleOut, a1, a2)}" fill="${ramp(share('D' + n))}" ${tipAttr('D' + n)}/>`;
      s += `<path d="${arc(R.trebleOut, R.doubleIn, a1, a2)}" fill="${ramp(share('S' + n) * 0.5)}" ${tipAttr('S' + n)}/>`;
      s += `<path d="${arc(R.trebleIn, R.trebleOut, a1, a2)}" fill="${ramp(share('T' + n))}" ${tipAttr('T' + n)}/>`;
      s += `<path d="${arc(R.bullOut, R.trebleIn, a1, a2)}" fill="${ramp(share('S' + n) * 0.5)}" ${tipAttr('S' + n)}/>`;
    });
    s += `<circle r="${R.bullOut}" fill="${ramp(share('SB'))}" ${tipAttr('SB')}/>`;
    s += `<circle r="${R.bullIn}" fill="${ramp(share('DB'))}" ${tipAttr('DB')}/>`;
    return s;
  }

  function boardFrame(inner) {
    let s = `<circle r="199" class="sb-rim"/>`;
    B.ORDER.forEach((n, i) => {
      const [x, y] = B.polar(185, i * 18);
      s += `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" class="sb-num">${n}</text>`;
    });
    return s + inner;
  }

  function drawHeat(canvas) {
    const size = canvas.clientWidth || 320, dpr = Math.min(2, window.devicePixelRatio || 1), W = Math.round(size * dpr);
    canvas.width = W; canvas.height = W;
    const ctx = canvas.getContext('2d');
    const h = stats.hits, n = h.length / 2;
    if (!n) return;
    const tmp = document.createElement('canvas');
    tmp.width = W; tmp.height = W;
    const t = tmp.getContext('2d');
    const rad = W * 0.032;
    const a = Math.min(0.5, Math.max(0.05, 6 / Math.sqrt(n)));
    for (let i = 0; i < h.length; i += 2) {
      const x = ((h[i] / 2 + 200) / 400) * W, y = ((h[i + 1] / 2 + 200) / 400) * W;
      const g = t.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, `rgba(0,0,0,${a})`); g.addColorStop(1, 'rgba(0,0,0,0)');
      t.fillStyle = g;
      t.fillRect(x - rad, y - rad, 2 * rad, 2 * rad);
    }
    const img = t.getImageData(0, 0, W, W), d = img.data;
    let maxA = 1;
    for (let i = 3; i < d.length; i += 4) if (d[i] > maxA) maxA = d[i];
    const pal = [];
    for (let v = 0; v < 256; v++) {
      const m = ramp(0.25 + 0.75 * (v / 255)).match(/\d+/g).map(Number);
      pal.push(m);
    }
    for (let i = 0; i < d.length; i += 4) {
      const v = d[i + 3] / maxA;
      if (v < 0.02) { d[i + 3] = 0; continue; }
      const c = pal[Math.round(v * 255)];
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = Math.round(Math.min(1, 0.35 + v) * 235);
    }
    ctx.putImageData(img, 0, 0);
  }

  function sparkline(hist) {
    const pts = hist.slice(-30).map((h) => h.avg);
    if (pts.length < 2) return '<p class="muted small">Nach zwei gespielten Spielen siehst du hier deinen Verlauf.</p>';
    const W = 320, H = 90, max = Math.max(...pts) * 1.1 || 1, min = Math.min(...pts) * 0.85;
    const xy = pts.map((v, i) => [(i / (pts.length - 1)) * W, H - ((v - min) / (max - min || 1)) * H]);
    const line = xy.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ');
    const last = xy[xy.length - 1];
    return `<svg viewBox="-6 -10 ${W + 12} ${H + 20}" class="spark" role="img" aria-label="Average der letzten ${pts.length} Spiele">
      <polyline points="0,${H} ${line} ${W},${H}" class="spark-fill"/>
      <polyline points="${line}" class="spark-line"/>
      <circle cx="${last[0]}" cy="${last[1]}" r="5" class="spark-dot"/>
    </svg>
    <div class="spark-legend"><span>Letzte ${pts.length} Spiele</span><span>zuletzt <b>${num(pts[pts.length - 1])}</b></span></div>`;
  }

  function renderStats() {
    const body = $('#stats-body');
    $('#stats-source').textContent = user ? 'Konto: ' + user.name : 'Auf diesem Gerät';
    if (!stats.darts) {
      body.innerHTML = `<div class="empty">
        <svg viewBox="-200 -200 400 400" aria-hidden="true"><circle r="170" class="e1"/><circle r="103" class="e2"/><circle r="16" class="e3"/></svg>
        <h3>Noch keine Würfe erfasst</h3>
        <p>Spiel ein Leg – mit Kamera oder per Eingabe. Danach siehst du hier, wohin du triffst, deinen Average und deine Doppelquote.</p>
        <button class="btn cta" id="st-play">Spiel starten</button></div>`;
      $('#st-play').onclick = () => { DS.renderHome(); DS.show('home'); };
      return;
    }
    const sm = S.summary(stats);
    const segMax = Math.max(1, ...B.ORDER.map((n) => sm.seg[n] || 0));
    const ringParts = [
      ['Single', sm.rings.S, 'ring-s'], ['Double', sm.rings.D, 'ring-d'], ['Triple', sm.rings.T, 'ring-t'],
      ['Bull', sm.rings.SB + sm.rings.DB, 'ring-b'], ['Miss', sm.rings.M, 'ring-m'],
    ];
    body.innerHTML = `
      <div class="kpis">
        <div class="kpi main"><b>${num(sm.avg)}</b><span>3-Dart-Average</span></div>
        <div class="kpi"><b>${num(sm.f9)}</b><span>First 9</span></div>
        <div class="kpi"><b>${pct(sm.dblPct)}</b><span>Doppelquote <small>${sm.dblHits}/${sm.dblAttempts}</small></span></div>
        <div class="kpi brass"><b>${sm.t180}</b><span>180er</span></div>
        <div class="kpi"><b>${sm.bestCheckout || '–'}</b><span>Höchstes Finish</span></div>
        <div class="kpi"><b>${sm.wins}<small>/${sm.games}</small></b><span>Siege</span></div>
        <div class="kpi"><b>${sm.darts}</b><span>Pfeile</span></div>
      </div>

      <section class="panel">
        <div class="panel-head">
          <h3>Wohin du triffst</h3>
          <div class="seg small" id="st-board-mode">
            <button data-m="heat" class="${boardMode === 'heat' ? 'on' : ''}">Heatmap</button>
            <button data-m="fields" class="${boardMode === 'fields' ? 'on' : ''}">Felder</button>
          </div>
        </div>
        <div class="stat-board">
          <svg viewBox="-200 -200 400 400" class="sb ${boardMode}" id="st-svg">${boardMode === 'fields' ? boardFrame(fieldsSvg(sm)) : B.svg('').replace(/^<svg[^>]*>|<\/svg>$/g, '')}</svg>
          ${boardMode === 'heat' ? '<canvas id="st-heat" class="heat"></canvas>' : ''}
          <div class="sb-tip hidden" id="st-tip"></div>
        </div>
        <p class="muted small">${boardMode === 'heat' ? `Die letzten ${stats.hits.length / 2} von der Kamera erkannten Treffer. Je heller, desto öfter.` : 'Jedes Feld eingefärbt nach Häufigkeit. Tippe auf ein Feld für Details.'}</p>
      </section>

      <section class="panel">
        <h3>Ringe</h3>
        <div class="ringbar">${ringParts.map(([l, n, c]) => n ? `<span class="${c}" style="flex:${n}" title="${l}: ${n}"></span>` : '').join('')}</div>
        <div class="ring-legend">${ringParts.map(([l, n, c]) => `<span><i class="${c}"></i>${l} <b>${Math.round((n / sm.total) * 100)} %</b></span>`).join('')}</div>
      </section>

      <section class="panel">
        <h3>Zahlen</h3>
        <div class="segbars">${B.ORDER.map((n) => { const v = sm.seg[n] || 0; return `<div class="sbar ${v === segMax ? 'top' : ''}" title="${n}: ${v} Pfeile"><span style="height:${Math.max(2, (v / segMax) * 100)}%"></span><b>${n}</b></div>`; }).join('')}</div>
        <p class="muted small">Pfeile pro Zahl, alle Ringe zusammen – in der Reihenfolge auf der Scheibe.</p>
      </section>

      <section class="panel">
        <h3>Häufigste Felder</h3>
        <ol class="toplist">${sm.top.map((t) => `<li><span class="f">${esc(t.label)}</span><span class="bar"><i style="width:${(t.pct / sm.top[0].pct) * 100}%"></i></span><span class="n">${t.n}</span></li>`).join('')}</ol>
      </section>

      <section class="panel">
        <h3>Verlauf</h3>
        ${sparkline(sm.history)}
      </section>

      <section class="panel figures">
        <div><b>${sm.t140}</b><span>140+</span></div>
        <div><b>${sm.t100}</b><span>100+</span></div>
        <div><b>${sm.bestTurn}</b><span>Beste Aufnahme</span></div>
        <div><b>${num(sm.bestAvg)}</b><span>Bestes Spiel (Ø)</span></div>
        <div><b>${sm.checkouts}</b><span>Finishes</span></div>
        <div><b>${sm.t60}</b><span>60+</span></div>
      </section>

      <button class="btn ghost wide" id="st-reset">Statistik zurücksetzen</button>`;

    $('#st-board-mode').onclick = (e) => {
      const b = e.target.closest('button[data-m]');
      if (!b) return;
      boardMode = b.dataset.m; LS.set('ds.statsBoard', boardMode); renderStats();
    };
    if (boardMode === 'heat') requestAnimationFrame(() => drawHeat($('#st-heat')));
    else {
      $('#st-svg').addEventListener('click', (e) => {
        const p = e.target.closest('[data-k]');
        const tip = $('#st-tip');
        if (!p) { tip.classList.add('hidden'); return; }
        tip.innerHTML = `<b>${esc(S.fieldLabel(p.dataset.k))}</b> ${p.dataset.n}× <span>${String(p.dataset.p).replace('.', ',')} %</span>`;
        tip.classList.remove('hidden');
      });
    }
    $('#st-reset').onclick = () => {
      if (!confirm(user ? 'Deine gesamte Statistik im Konto löschen? Das lässt sich nicht rückgängig machen.' : 'Die Statistik auf diesem Gerät löschen?')) return;
      stats = S.empty(); save(); renderStats();
    };
  }

  // ================= Weltrangliste =================
  let rankField = 'rankAvg';
  $('#rank-tabs').onclick = (e) => {
    const b = e.target.closest('button[data-f]');
    if (!b) return;
    rankField = b.dataset.f;
    $$('#rank-tabs button').forEach((x) => x.classList.toggle('on', x === b));
    renderRank();
  };
  const fmtRank = (f, r) => (f === 'rankAvg' ? num(r.rankAvg, 2) : String(r[f] || 0));
  const rankNote = { rankAvg: 'Average über alle Pfeile – gewertet ab 99 Pfeilen.', t180: 'Anzahl geworfener 180er.', bestCheckout: 'Höchstes gecheckte Finish.', wins: 'Gewonnene Spiele.' };

  async function renderRank() {
    const body = $('#rank-body');
    if (!acct().available) {
      body.innerHTML = `<div class="empty">
        <h3>Weltrangliste noch nicht eingerichtet</h3>
        <p>Für Rangliste und Konten braucht die Seite einen kostenlosen Firebase-Zugang. Wer die Seite betreibt, trägt ihn in <code>firebase-config.js</code> ein – die Anleitung steht im README.</p>
        <p class="muted small">Deine Statistik wird bis dahin auf diesem Gerät gespeichert.</p></div>`;
      return;
    }
    body.innerHTML = `<div class="loading">Lade Rangliste …</div>`;
    let rows;
    try { rows = await acct().fetchLeaderboard(rankField, 50); }
    catch (e) { body.innerHTML = `<div class="empty"><h3>Rangliste nicht erreichbar</h3><p>${esc(e.message)}</p><button class="btn" id="rk-retry">Erneut laden</button></div>`; $('#rk-retry').onclick = renderRank; return; }
    if (current !== 'rank') return;
    const mine = user && rows.findIndex((r) => r.uid === user.uid);
    const cta = !user ? `<div class="rank-cta"><span>Melde dich an, um in der Rangliste zu erscheinen.</span><button class="btn cta" id="rk-login">Anmelden</button></div>` :
      mine < 0 && rankField === 'rankAvg' && stats.darts < 99 ? `<div class="rank-cta"><span>Noch ${99 - stats.darts} Pfeile bis zu deiner Average-Wertung.</span></div>` : '';
    body.innerHTML = `${cta}
      ${rows.length ? `<ol class="ranklist">${rows.map((r, i) => `
        <li class="${user && r.uid === user.uid ? 'me' : ''} ${i < 3 ? 'podium p' + (i + 1) : ''}">
          <span class="pos">${i + 1}</span>
          <span class="avatar">${r.photo ? `<img src="${esc(r.photo)}" alt="" referrerpolicy="no-referrer">` : esc((r.name || '?').slice(0, 1).toUpperCase())}</span>
          <span class="who"><b>${esc(r.name || 'Spieler')}</b><small>${r.darts || 0} Pfeile, ${r.games || 0} Spiele</small></span>
          <span class="val">${fmtRank(rankField, r)}</span>
        </li>`).join('')}</ol>` : '<div class="empty"><h3>Noch niemand in dieser Wertung</h3><p>Spiel ein paar Legs – der erste Platz ist frei.</p></div>'}
      <p class="muted small center">${rankNote[rankField]}</p>`;
    const l = $('#rk-login');
    if (l) l.onclick = () => { DS.show('profile'); renderProfile(); };
  }

  // ================= Profil & Anmeldung =================
  let authMode = 'login';
  function renderProfile() {
    const body = $('#profile-body');
    const sm = S.summary(stats);
    const settingsBtn = `<section class="panel"><h3>Kamera &amp; Erkennung</h3><p class="muted small">Empfindlichkeit, Ansage, automatisches Weiterschalten und mehr.</p><button class="btn" id="pf-settings">Einstellungen öffnen</button></section>`;
    if (!acct().available) {
      body.innerHTML = `<section class="panel">
          <h3>Konten sind noch nicht eingerichtet</h3>
          <p class="muted">Deine Statistik wird auf diesem Gerät gespeichert (${stats.darts} Pfeile). Sobald die Seite mit Firebase verbunden ist, kannst du dich mit Google oder E-Mail anmelden und deine Würfe werden ins Konto übernommen.</p>
          ${acct().error ? `<p class="err">${esc(acct().error)}</p>` : ''}
        </section>${settingsBtn}`;
      $('#pf-settings').onclick = DS.openSettings;
      return;
    }
    if (!user) {
      body.innerHTML = `<section class="panel auth">
          <h3>${authMode === 'signup' ? 'Konto erstellen' : 'Anmelden'}</h3>
          <p class="muted small">Mit einem Konto wird deine Statistik gesichert, ist auf all deinen Geräten da und du erscheinst in der Weltrangliste.</p>
          <button class="btn google wide" id="pf-google">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="#4285F4" d="M22.5 12.2c0-.8-.1-1.5-.2-2.2H12v4.2h5.9c-.3 1.4-1 2.5-2.2 3.3v2.7h3.6c2.1-1.9 3.2-4.8 3.2-8z"/><path fill="#34A853" d="M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.7c-1 .7-2.2 1.1-3.7 1.1-2.9 0-5.3-1.9-6.2-4.5H2.1v2.8C3.9 20.6 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.8 14.2c-.2-.7-.4-1.4-.4-2.2s.1-1.5.4-2.2V7H2.1C1.4 8.5 1 10.2 1 12s.4 3.5 1.1 5l3.7-2.8z"/><path fill="#EA4335" d="M12 5.4c1.6 0 3.1.6 4.2 1.7l3.2-3.2C17.5 2.1 15 1 12 1 7.7 1 3.9 3.4 2.1 7l3.7 2.8C6.7 7.2 9.1 5.4 12 5.4z"/></svg>
            Mit Google anmelden</button>
          <div class="or">oder mit E-Mail</div>
          <form id="pf-form" class="form">
            ${authMode === 'signup' ? '<label class="field-label" for="pf-name">Name in der Rangliste</label><input id="pf-name" maxlength="24" autocomplete="nickname" required />' : ''}
            <label class="field-label" for="pf-email">E-Mail</label>
            <input id="pf-email" type="email" autocomplete="email" required />
            <label class="field-label" for="pf-pw">Passwort</label>
            <input id="pf-pw" type="password" autocomplete="${authMode === 'signup' ? 'new-password' : 'current-password'}" minlength="6" required />
            <p class="err hidden" id="pf-err"></p>
            <button class="btn cta wide" type="submit">${authMode === 'signup' ? 'Konto erstellen' : 'Anmelden'}</button>
          </form>
          <div class="auth-links">
            <button class="link" id="pf-switch">${authMode === 'signup' ? 'Schon ein Konto? Anmelden' : 'Noch kein Konto? Konto erstellen'}</button>
            ${authMode === 'login' ? '<button class="link" id="pf-reset">Passwort vergessen</button>' : ''}
          </div>
        </section>
        ${stats.darts ? `<p class="muted small center">${stats.darts} Pfeile auf diesem Gerät werden beim Anmelden in dein Konto übernommen.</p>` : ''}
        ${settingsBtn}`;
      const err = (m) => { const e = $('#pf-err'); e.textContent = m; e.classList.remove('hidden'); };
      $('#pf-google').onclick = async () => { try { await acct().signInGoogle(); } catch (e) { err(e.message); } };
      $('#pf-switch').onclick = () => { authMode = authMode === 'signup' ? 'login' : 'signup'; renderProfile(); };
      const rs = $('#pf-reset');
      if (rs) rs.onclick = async () => {
        const mail = $('#pf-email').value.trim();
        if (!mail) return err('Gib zuerst deine E-Mail-Adresse ein.');
        try { await acct().resetPassword(mail); DS.toast('E-Mail zum Zurücksetzen verschickt'); } catch (e) { err(e.message); }
      };
      $('#pf-form').onsubmit = async (e) => {
        e.preventDefault();
        const btn = e.target.querySelector('button[type=submit]');
        btn.disabled = true;
        try {
          const mail = $('#pf-email').value.trim(), pw = $('#pf-pw').value;
          if (authMode === 'signup') await acct().signUpEmail(mail, pw, $('#pf-name').value.trim());
          else await acct().signInEmail(mail, pw);
        } catch (x) { err(x.message); btn.disabled = false; }
      };
      $('#pf-settings').onclick = DS.openSettings;
      return;
    }
    const syncText = { ok: 'Gesichert ✓', pending: 'Wird gesichert …', error: 'Nicht gesichert: ' + sync.msg, local: '' }[sync.state] || '';
    body.innerHTML = `<section class="panel profile-card">
        <span class="avatar big">${user.photo ? `<img src="${esc(user.photo)}" alt="" referrerpolicy="no-referrer">` : esc(user.name.slice(0, 1).toUpperCase())}</span>
        <div class="who">
          <form id="pf-nameform" class="name-edit"><input id="pf-newname" value="${esc(user.name)}" maxlength="24" aria-label="Name in der Rangliste" /><button class="btn" type="submit">Speichern</button></form>
          <small>${esc(user.email)}</small>
          <small class="sync ${sync.state}">${esc(syncText)}</small>
        </div>
      </section>
      <section class="panel figures">
        <div><b>${num(sm.avg)}</b><span>Average</span></div>
        <div><b>${sm.darts}</b><span>Pfeile</span></div>
        <div><b>${sm.wins}/${sm.games}</b><span>Siege</span></div>
      </section>
      ${settingsBtn}
      <button class="btn ghost wide" id="pf-logout">Abmelden</button>`;
    $('#pf-nameform').onsubmit = async (e) => {
      e.preventDefault();
      const n = $('#pf-newname').value.trim();
      if (!n) return;
      try { await acct().setName(n); scheduleCloud(); DS.toast('Name gespeichert ✓'); } catch (x) { DS.toast(x.message); }
    };
    $('#pf-logout').onclick = () => acct().signOut();
    $('#pf-settings').onclick = DS.openSettings;
  }

  renderChip();
})();
