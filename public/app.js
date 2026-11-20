(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const Game = window.DartGame;
  const B = window.Board;
  const D = window.Detector;

  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
    del(k) { try { localStorage.removeItem(k); } catch (_) {} },
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const settings = Object.assign(
    { threshold: 28, tipMode: 'auto', voice: true, autoNext: true, startScore: 501, doubleOut: true, name: '' },
    LS.get('ds.settings', {})
  );
  const saveSettings = () => LS.set('ds.settings', settings);

  // ---------- Zustand ----------
  let mode = null;        // 'local' | 'online' | 'test'
  let game = null;
  let myId = null, room = null, ws = null, pingTimer = null;
  let tourn = null, tId = null;           // Turnier
  let screen = 'home';
  let lastTurnKey = null;
  let testHits = [];

  // ---------- Hilfen ----------
  let toastTimer;
  function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  // Sprachausgabe (speech.js): mehrere kurze Ansagen nacheinander, natürlichste verfügbare Stimme
  function speak(parts, opts) {
    if (!settings.voice || !window.Speech) return;
    window.Speech.say(parts, opts);
  }
  const say = (d) => (window.VoiceCmd ? window.VoiceCmd.label(d) : B.speech(d));

  function show(name) {
    screen = name;
    $$('.screen').forEach((s) => s.classList.toggle('hidden', s.id !== 'screen-' + name));
    const slot = name === 'game' ? $('#cam-slot') : name === 'cam' ? $('#cam-slot-test') : name === 'learnplay' ? $('#cam-slot-learn') : null;
    const panel = $('#cam-panel');
    if (slot) { slot.appendChild(panel); panel.classList.remove('hidden'); }
    else panel.classList.add('hidden');
    $('#room-badge').classList.toggle('hidden', !((mode === 'online' && room) || tourn));
    if (tourn) $('#room-badge').textContent = 'T·' + tourn.code;
    else if (room) $('#room-badge').textContent = room.code;
    $('#b-tree').classList.toggle('hidden', !(room && room.tourn));
    // Tab-Leiste: im Spiel ausgeblendet (volle Konzentration), sonst passenden Tab markieren
    const tab = { home: 'home', local: 'home', online: 'home', lobby: 'home', cam: 'home', learn: 'home', learnplay: 'home', tourn: 'home', tlobby: 'home', stats: 'stats', rank: 'rank', profile: 'profile' }[name];
    document.body.classList.toggle('in-game', name === 'game' || name === 'learnplay');
    $$('#tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    window.scrollTo(0, 0);
    hooks.show.forEach((fn) => fn(name));
  }

  // Schnittstelle für ui.js (Statistik, Rangliste, Profil)
  const hooks = { update: [], show: [], home: [] };
  window.DS = {
    hooks, settings, saveSettings, toast, esc, LS, show: (n) => show(n),
    get game() { return game; }, get mode() { return mode; }, get myId() { return myId; }, get room() { return room; },
    meIndex() {
      if (!game) return -1;
      if (mode === 'online') return game.players.findIndex((p) => p.id === myId);
      if (mode === 'local') { const i = settings.mePlayer ?? 0; return i >= 0 && i < game.players.length ? i : -1; }
      return -1;
    },
    goHome: (f) => goHome(f),
    renderHome: () => renderHome(),
    openSettings: () => $('#b-settings').click(),
  };

  // ---------- Spiel-Einstellungen (Modus / Finish) ----------
  function renderGameSettings(el, editable) {
    const seg = (k, opts) =>
      `<div class="seg" data-k="${k}">${opts
        .map(([v, l]) => `<button type="button" data-v="${v}" class="${String(settings[k]) === String(v) ? 'on' : ''}" ${editable ? '' : 'disabled'}>${l}</button>`)
        .join('')}</div>`;
    el.innerHTML =
      `<h3>Modus</h3>` + seg('startScore', [[301, '301'], [501, '501'], [701, '701']]) +
      `<h3>Finish</h3>` + seg('doubleOut', [[true, 'Double-Out'], [false, 'Single-Out']]) +
      (editable ? '' : `<p class="muted small">Der Host wählt den Modus.</p>`);
    el.onclick = (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b || !editable) return;
      const k = b.parentElement.dataset.k;
      settings[k] = k === 'doubleOut' ? b.dataset.v === 'true' : Number(b.dataset.v);
      saveSettings();
      renderGameSettings(el, editable);
    };
  }

  // ---------- Lokal ----------
  let localNames = LS.get('ds.localPlayers', ['Spieler 1', 'Spieler 2']);
  function renderLocalPlayers() {
    const me = settings.mePlayer ?? 0;
    $('#local-players').innerHTML = localNames
      .map((n, i) => `<div class="player-row">
        <button type="button" class="me-toggle ${i === me ? 'on' : ''}" data-me="${i}" aria-pressed="${i === me}" title="${i === me ? 'Das bist du' : 'Als mich markieren'}">${i === me ? 'Ich' : ''}</button>
        <input data-i="${i}" value="${esc(n)}" maxlength="16" aria-label="Name Spieler ${i + 1}" />
        ${localNames.length > 1 ? `<button type="button" class="btn icon ghost" data-del="${i}" aria-label="Spieler entfernen">✕</button>` : ''}</div>`)
      .join('');
  }
  $('#local-players').addEventListener('input', (e) => {
    if (e.target.dataset.i != null) { localNames[e.target.dataset.i] = e.target.value; LS.set('ds.localPlayers', localNames); }
  });
  $('#local-players').addEventListener('click', (e) => {
    const m = e.target.closest('[data-me]');
    if (m) { const i = Number(m.dataset.me); settings.mePlayer = settings.mePlayer === i ? -1 : i; saveSettings(); renderLocalPlayers(); return; }
    const del = e.target.closest('[data-del]');
    const d = del && del.dataset.del;
    if (d != null) {
      localNames.splice(Number(d), 1); LS.set('ds.localPlayers', localNames);
      if ((settings.mePlayer ?? 0) >= localNames.length) { settings.mePlayer = 0; saveSettings(); }
      renderLocalPlayers();
    }
  });
  $('#add-player').onclick = () => {
    if (localNames.length >= 8) return toast('Maximal 8 Spieler');
    localNames.push('Spieler ' + (localNames.length + 1));
    LS.set('ds.localPlayers', localNames);
    renderLocalPlayers();
  };
  // ---------- Dartcoins (1 Runde = 1 Coin; in der Testphase unbegrenzt) ----------
  const Coins = window.Coins;
  function renderCoins() {
    $('#coin-ic').innerHTML = Coins.ICON;
    $('#coin-val').textContent = Coins.label();
  }
  Coins.onChange(renderCoins);
  renderCoins();
  $('#coin-chip').onclick = () => {
    $('#coin-big').innerHTML = Coins.ICON;
    $('#coin-bal').textContent = Coins.label();
    $('#coin-bal-sub').textContent = Coins.unlimited ? 'Testphase – unbegrenzt' : 'Coins auf deinem Konto';
    $('#coin-played').textContent = Coins.played ? `Du hast schon ${Coins.played} ${Coins.played === 1 ? 'Runde' : 'Runden'} gespielt.` : '';
    $('#dlg-coins').showModal();
  };
  // true = darf spielen. Ohne Coins: Hinweis (später: Video ansehen → +1 Coin)
  function payRound(reason) {
    if (Coins.spend(1, reason)) return true;
    toast('Keine Dartcoins mehr – schau ein kurzes Video unserer Partner, um weiterzuspielen.', 4500);
    $('#coin-chip').click();
    return false;
  }
  let paidGameId = null;
  window.DS.payRound = payRound;

  $('#start-local').onclick = () => {
    if (!payRound('lokal')) return;
    const players = localNames.map((n, i) => ({ id: 'p' + i, name: n.trim() || 'Spieler ' + (i + 1) }));
    const acc = window.Account && window.Account.user;
    const me = settings.mePlayer ?? 0;
    if (acc && players[me] && /^Spieler \d+$/.test(players[me].name)) players[me].name = acc.name.slice(0, 16);
    game = Game.create(players, { startScore: settings.startScore, doubleOut: settings.doubleOut });
    startGameView('local');
  };

  function startGameView(m) {
    mode = m;
    lastTurnKey = null;
    winShownFor = null;
    resetAnnounce();
    if (m === 'local') LS.set('ds.localGame', game);
    show('game');
    update();
    if (!stream) toast('Tipp: Kamera starten und kalibrieren – oder manuell eingeben.');
  }

  // ---------- Aktionen (lokal direkt, online über den Server) ----------
  const act = {
    dart(d) { if (mode === 'online') return send({ t: 'dart', dart: d }); if (Game.addDart(game, d)) localChanged(); },
    set(i, d) { if (mode === 'online') return send({ t: 'set', index: i, dart: d }); if (Game.setDart(game, i, d)) localChanged(); },
    remove(i) { if (mode === 'online') return send({ t: 'remove', index: i }); if (Game.removeDart(game, i)) localChanged(); },
    undo() { if (mode === 'online') return send({ t: 'undo' }); if (Game.undo(game)) localChanged(); },
    next() { if (mode === 'online') return send({ t: 'next' }); if (Game.next(game)) localChanged(); },
    rematch() {
      if (mode === 'online') return send({ t: 'rematch' });
      if (!payRound('lokal')) return;
      game = Game.rematch(game);
      winShownFor = null;
      localChanged();
    },
  };
  function localChanged() { LS.set('ds.localGame', game); update(); }

  // Pfeil korrigieren (Antippen oder Sprachbefehl). index null = letzter Pfeil; ist die aktuelle Aufnahme leer,
  // wird die vorherige korrigiert. Die Erkennung lernt daraus, und das Bild landet im Erkennungsprotokoll.
  function correctDart(index, d, spoken) {
    if (!game) return false;
    let old = null;
    if (game.turn.darts.length) old = game.turn.darts[index == null ? game.turn.darts.length - 1 : index];
    else {
      const pi = (game.current - 1 + game.players.length) % game.players.length;
      const h = game.players[pi].history[game.players[pi].history.length - 1];
      if (h) old = h.darts[index == null ? h.darts.length - 1 : index];
    }
    if (!old) { if (spoken) speak('Kein Pfeil zum Korrigieren', { force: true }); return false; }
    const changed = old.seg !== d.seg || old.mult !== d.mult;
    if (old.auto && (old.seg !== d.seg || old.mult !== d.mult)) {
      detector.learnFromCorrection(old, d);
      addReport(old, d);
    }
    if (mode === 'online') send({ t: 'correct', index, dart: d });
    else if (Game.correct(game, index, d)) localChanged();
    if (spoken) speak('Korrigiert auf ' + say(d), { force: true, interrupt: true });
    return changed;
  }
  window.DS_correct = correctDart;

  // ---------- Erkennungsprotokoll (zum Verbessern der Erkennung mit echten Bildern) ----------
  const reports = [];
  function addReport(old, d) {
    const cap = detector.captures && detector.captures.find((c) => c.id === old.cid);
    reports.push({ t: new Date().toISOString(), detected: B.label(old), corrected: B.label(d), x: old.x, y: old.y, bdir: old.bdir, bias: detector.tipBias || 0, cap });
    if (reports.length > 40) reports.shift();
    $('#s-report-n').textContent = reports.length;
  }
  function toPng(arr, size) {
    const c = document.createElement('canvas'); c.width = size; c.height = size;
    const x = c.getContext('2d'); const im = x.createImageData(size, size); im.data.set(arr); x.putImageData(im, 0, 0);
    return c.toDataURL('image/png');
  }
  function downloadReport() {
    if (!reports.length) return toast('Noch keine korrigierten Würfe – korrigiere falsch erkannte Pfeile, dann landen sie hier.');
    const q = detector.qualityInfo();
    const out = {
      app: 'DartScan', created: new Date().toISOString(), ua: navigator.userAgent,
      setup: { calib: detector.calib, view: detector.view, hz: detector.hz, w: detector.w, h: detector.h, threshold: detector.threshold, tipBias: detector.tipBias || 0, quality: q },
      entries: reports.map((r) => ({ ...r, cap: r.cap ? { tip: r.cap.tip, before: toPng(r.cap.before, r.cap.size), after: toPng(r.cap.after, r.cap.size) } : null })),
    };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(out)], { type: 'application/json' }));
    a.download = 'dartscan-protokoll-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.json';
    document.body.appendChild(a); a.click(); a.remove();
  }

  const myTurn = () => !!game && (mode === 'local' || game.players[game.current].id === myId);
  const canEdit = () => myTurn() || (mode === 'online' && room && room.hostId === myId);

  // ---------- Anzeige ----------
  function update() {
    if (!game) return;
    renderScoreboard();
    renderTurn();
    renderMini();
    syncDetector();
    announce();
    checkWin();
    $('#game-mode').textContent = `${game.startScore}, ${game.doubleOut ? 'Double-Out' : 'Single-Out'}`;
    hooks.update.forEach((fn) => { try { fn(game); } catch (e) { console.error(e); } });
  }

  function renderScoreboard() {
    const meIdx = window.DS.meIndex();
    $('#scoreboard').innerHTML = game.players
      .map((p, i) => {
        const st = Game.stats(game, i);
        const rp = room && room.players.find((x) => x.id === p.id);
        const offline = mode === 'online' && rp && !rp.online;
        const active = i === game.current && !game.finished;
        const tag = i === meIdx ? '<span class="you">du</span>' : '';
        return `<div class="pcard ${active ? 'active' : ''}">
          <div class="pname"><span class="nm">${esc(p.name)}</span>${tag}${p.legs ? `<span class="legs">${p.legs} ${p.legs > 1 ? 'Legs' : 'Leg'}</span>` : ''}${offline ? '<span class="off">offline</span>' : ''}</div>
          <div class="pscore">${p.score}</div>
          <div class="pmeta"><span>Ø ${st.avg.toFixed(1).replace('.', ',')}</span><span>${st.darts} Pfeile</span></div>
        </div>`;
      })
      .join('');
  }

  function chipHTML(d, i, clickable) {
    if (!d) return `<div class="chip">–</div>`;
    const cls = ['chip', 'filled', d.mult === 2 ? 'd' : d.mult === 3 ? 't' : '', d.void ? 'void' : ''].join(' ');
    return `<div class="${cls}" data-i="${i}" ${clickable ? 'role="button" tabindex="0" title="Korrigieren"' : ''}>${B.label(d)}<small>${d.auto ? 'Kamera' : 'von Hand'}</small></div>`;
  }

  function renderTurn() {
    const t = game.turn;
    const p = game.players[game.current];
    const mine = myTurn();
    $('#turn-name').textContent = mode === 'online' && !mine ? `${p.name} wirft …` : `${p.name} ist dran`;
    const total = t.darts.filter((d) => !d.void).reduce((s, d) => s + d.value, 0);
    $('#turn-total').textContent = t.bust ? 'Bust' : total ? total : '';
    $('#turn-total').classList.toggle('max', total === 180 && !t.bust);
    $('#turn-darts').innerHTML = [0, 1, 2].map((i) => chipHTML(t.darts[i], i, canEdit())).join('');

    let info = '';
    if (t.won) info = `<span class="co">Game shot!</span>`;
    else if (t.bust) info = `<span class="bust">Bust</span> Überworfen – Pfeile ziehen, dann weiter`;
    else if (Game.turnComplete(game)) info = 'Pfeile ziehen – dann geht es weiter';
    else {
      const co = Game.checkout(p.score, 3 - t.darts.length, game.doubleOut);
      if (co) info = `<span class="co-label">Finish</span><span class="co">${co.map((c) => `<b>${c}</b>`).join('')}</span>`;
    }
    $('#turn-info').innerHTML = info;

    ['#b-manual', '#b-miss', '#b-next'].forEach((s) => ($(s).disabled = !(mine && !game.finished)));
    $('#b-undo').disabled = !canEdit();
  }

  let miniReady = false;
  function renderMini() {
    if (!miniReady) {
      $('#mini-board').innerHTML = B.svg('<g id="hits"></g>');
      miniReady = true;
    }
    const darts = game.turn.darts;
    $('#hits').innerHTML = darts
      .map((d, i) => {
        const pos = Number.isFinite(d.x) ? [d.x, d.y] : B.position(d);
        if (!pos) return '';
        return `<g transform="translate(${pos[0].toFixed(1)} ${pos[1].toFixed(1)})" opacity="${d.void ? 0.4 : 1}">
          <circle r="10" fill="#ece0bf" stroke="#131518" stroke-width="3"/>
          <text y="1" font-size="13" font-weight="800" text-anchor="middle" dominant-baseline="central" fill="#131518" font-family="Big Shoulders Display, system-ui">${i + 1}</text></g>`;
      })
      .join('');
  }

  // Ansage + Aufblitzen neuer Pfeile
  let ann = null;
  function resetAnnounce() { ann = null; }
  function announce() {
    const t = game.turn;
    const cur = { id: game.turnId, n: t.darts.length };
    if (ann && ann.id === cur.id && cur.n === ann.n + 1) {
      const d = t.darts[cur.n - 1];
      const chip = $(`#turn-darts .chip[data-i="${cur.n - 1}"]`);
      if (chip) chip.classList.add('flash');
      // jede Ansage einzeln – nie "Zahl + Punkt" (sonst liest die Stimme z. B. "3. 60" als "dritter sechzig")
      const parts = [say(d)];
      const p = game.players[game.current];
      if (t.won) parts.push('Game shot!');
      else if (t.bust) parts.push('Überworfen');
      else if (cur.n === 3) {
        const total = t.darts.reduce((s, x) => s + x.value, 0);
        parts.push(total === 180 ? 'Hundertachtzig!' : String(total));
        if (Game.checkout(p.score, 3, game.doubleOut)) parts.push('Rest ' + p.score);
      }
      speak(parts);
    }
    ann = cur;
  }

  let winShownFor = null;
  function checkWin() {
    const dlg = $('#dlg-win');
    if (!game.finished) { if (dlg.open) dlg.close(); return; }
    if (winShownFor === game.turnId) return;
    winShownFor = game.turnId;
    const idx = game.players.findIndex((p) => p.id === game.winner);
    const w = game.players[idx];
    const st = Game.stats(game, idx);
    $('#win-text').textContent = `${w.name} gewinnt!`;
    $('#win-sub').textContent = `${st.darts} Pfeile · Ø ${st.avg.toFixed(1)}`;
    const host = mode !== 'online' || (room && room.hostId === myId);
    $('#w-rematch').disabled = !host;
    $('#w-rematch').textContent = host ? 'Revanche' : 'Warte auf Revanche vom Host …';
    if (room && room.tourn) {
      const legs = w.legs + 1, need = room.legsToWin || 1;
      $('#win-sub').textContent += legs >= need ? ' · Match entschieden!' : ` · Leg ${legs}/${need} – nächstes Leg startet gleich …`;
      $('#w-rematch').classList.add('hidden');
      $('#w-home').textContent = 'Zum Turnierbaum';
    } else { $('#w-rematch').classList.remove('hidden'); $('#w-home').textContent = 'Zur Startseite'; }
    $('#w-undo').classList.toggle('hidden', !canEdit());
    if (!dlg.open) dlg.showModal();
  }
  $('#w-rematch').onclick = () => { $('#dlg-win').close(); act.rematch(); };
  $('#w-undo').onclick = () => { $('#dlg-win').close(); winShownFor = null; act.undo(); };
  $('#w-home').onclick = () => { $('#dlg-win').close(); if (room && room.tourn) { renderTLobby(); show('tlobby'); } else goHome(); };

  // ---------- Steuerung ----------
  $('#b-miss').onclick = () => { act.dart({ seg: 0, mult: 0 }); detector.rebaseline(); };
  $('#b-undo').onclick = () => act.undo();
  $('#b-next').onclick = () => act.next();
  $('#b-manual').onclick = () => openInput(null);
  $('#s-report').onclick = downloadReport;

  // ---------- Sprachbefehle wie bei Siri: "Hey DartScan, korrigiere auf Triple 20" ----------
  const VC = window.VoiceCmd;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null, micOn = false, wakeUntil = 0, micRestartT = null;
  let listening = false, recStartedAt = 0, micFails = 0, micErr = '';
  function setMicUI() {
    const b = $('#b-mic');
    b.classList.toggle('hidden', !SR);
    b.classList.toggle('on', micOn && listening);
    b.classList.toggle('wait', micOn && !listening);
    b.setAttribute('aria-pressed', String(micOn));
    $('#b-mic-label').textContent = !micOn ? 'Sprachbefehle' : listening ? 'Hört zu' : micErr ? micErr : 'Startet …';
  }
  let lastChime = 0, ignoreUntil = 0;
  const caption = (t, cls) => { const c = $('#mic-caption'); c.textContent = t || ''; c.className = 'mic-caption' + (cls ? ' ' + cls : ''); };
  function chime() { if (Date.now() - lastChime > 2500) { lastChime = Date.now(); window.Sound && window.Sound.wake(); } }

  function micStart() {
    micRestartT = null;
    if (!SR) { toast('Sprachbefehle gehen in diesem Browser nicht – am besten Chrome oder Edge verwenden.', 4500); return; }
    micOn = true;
    if (rec) return setMicUI();
    rec = new SR();
    rec.lang = 'de-DE'; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 5;
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const alts = Array.from(r, (a) => a.transcript);
        // Die eigene Ansage enthält nie "DartScan" oder "korrigiere" – sie kann also keinen Befehl auslösen.
        caption('„' + alts[0].trim() + '“', r.isFinal ? '' : 'live');
        if (!r.isFinal) {
          // Aktivierungswort schon während des Sprechens erkennen -> sofort Signalton
          if (alts.some((a) => VC.findWake(VC.normalize(a)) >= 0)) { chime(); wakeUntil = Date.now() + 8000; }
          continue;
        }
        handleSpeech(alts);
      }
    };
    rec.onstart = () => { listening = true; micErr = ''; recStartedAt = Date.now(); setMicUI(); };
    rec.onaudiostart = () => { listening = true; setMicUI(); };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        micOn = false; settings.mic = false; saveSettings();
        toast('Mikrofon nicht erlaubt – in den Browser-Einstellungen für diese Seite freigeben.', 5000);
      } else if (e.error === 'network') micErr = 'Kein Netz';
      else if (e.error === 'audio-capture') { micErr = 'Kein Mikrofon'; }
      // 'no-speech' und 'aborted' sind normal (Stille) -> einfach neu starten
    };
    // Die Erkennung beendet sich nach Stille von selbst -> neu starten, solange eingeschaltet.
    // Bricht sie sofort wieder ab (Netz weg, Mikro belegt), mit wachsender Pause neu versuchen statt Dauerschleife.
    rec.onend = () => {
      const ran = recStartedAt ? Date.now() - recStartedAt : 0;
      rec = null; listening = false; recStartedAt = 0;
      micFails = ran > 1500 ? 0 : micFails + 1;
      const wait = micFails ? Math.min(5000, 250 * 2 ** micFails) : 120;
      clearTimeout(micRestartT);
      if (micOn) micRestartT = setTimeout(micStart, wait);
      if (micFails === 4) toast('Spracherkennung startet nicht richtig – Internet und Mikrofon prüfen', 4000);
      setMicUI();
    };
    try { rec.start(); } catch (_) { rec = null; clearTimeout(micRestartT); micRestartT = setTimeout(micStart, 1000); }
    setMicUI();
  }
  // Wächter: läuft die Erkennung nicht, obwohl sie an sein soll (z. B. nach Bildschirm aus), neu starten
  setInterval(() => { if (micOn && !rec && !micRestartT) micStart(); }, 4000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !micOn) return;
    if (rec) { try { rec.abort(); } catch (_) {} } else micStart();
  });
  function micStop() {
    micOn = false; clearTimeout(micRestartT); micRestartT = null; listening = false; micErr = '';
    if (rec) { try { rec.abort(); } catch (_) {} rec = null; }
    caption('');
    setMicUI();
  }

  function handleSpeech(alts) {
    const direct = settings.voiceDirect !== false;
    let best = null;
    for (const a of alts) {
      let r = VC.parse(a, { direct });
      // "Hey DartScan" … Signalton … "korrigiere 4 auf 18": Befehl kommt kurz danach ohne Aktivierungswort
      if (!r.wake && !r.direct && Date.now() < wakeUntil) { const cmds = VC.parseCommands(a); r = { wake: true, commands: cmds, command: cmds[0] || null, rest: VC.normalize(a) }; }
      if ((r.wake || r.direct) && r.commands.length && r.commands.every((c) => c.type !== 'unknown')) { best = r; break; }
      if ((r.wake || r.direct) && !best) best = r;
    }
    if (!best) return;
    const b = $('#b-mic');
    b.classList.remove('heard'); void b.offsetWidth; b.classList.add('heard');
    if (!best.commands.length) { chime(); wakeUntil = Date.now() + 8000; caption('Ich höre … z. B. „weiter“ oder „korrigiere 4 auf 18“', 'live'); return; }
    wakeUntil = 0;
    if (best.commands.some((c) => c.type === 'unknown')) return fail(`„${best.rest}“ nicht verstanden – z. B. „korrigiere 4 auf 18“`);
    if (!game || screen !== 'game') return;
    if (!canEdit()) return fail('Du bist gerade nicht dran');
    const done = [];
    for (const c of best.commands) {
      if (c.type === 'correct') {
        // Ziel: aktuelle Aufnahme, oder die vorherige, wenn schon weitergeschaltet wurde
        let darts = game.turn.darts;
        if (!darts.length) { const pi = (game.current - 1 + game.players.length) % game.players.length; const h = game.players[pi].history.slice(-1)[0]; darts = h ? h.darts : []; }
        let idx = c.index;
        if (c.from) {
          idx = VC.matchDart(darts, c.from);
          if (idx < 0) { fail(`Keine ${VC.label(c.from)} in der Aufnahme gefunden`); continue; }
        }
        if (correctDart(idx, c.dart, false)) done.push((c.from ? VC.label(c.from) + ' → ' : '') + VC.label(c.dart));
        else if (idx != null || darts.length) done.push(VC.label(c.dart));
      } else if (c.type === 'add') { act.dart(c.dart); detector.rebaseline(); done.push('+ ' + VC.label(c.dart)); }
      else if (c.type === 'next') { act.next(); done.push('Weiter'); }
      else if (c.type === 'undo') { act.undo(); done.push('Zurück'); }
    }
    if (!done.length) return;
    window.Sound && window.Sound.ok();
    caption('✓ ' + done.join(', '), 'ok');
    toast(done.join(', '));
    // Bestätigung ohne die Wörter "korrigiere/auf" – sonst würde die eigene Ansage als Befehl erkannt
    ignoreUntil = Date.now() + 2500;
    speak('Okay. ' + best.commands.filter((c) => c.dart).map((c) => VC.label(c.dart)).join(', '), { force: true, interrupt: true });
  }
  function fail(msg) {
    window.Sound && window.Sound.err();
    caption(msg, 'err');
    toast(msg, 4500);
  }
  $('#b-mic').onclick = () => {
    if (micOn) { micStop(); settings.mic = false; }
    else { micStart(); settings.mic = true; if (SR) { window.Sound && window.Sound.wake(); toast('Sag z. B. „Hey DartScan, korrigiere 4 auf 18“ oder „Hey DartScan, weiter“', 5000); } }
    saveSettings();
  };
  hooks.show.push((name) => { if (name === 'game') { if (settings.mic && !micOn) micStart(); } else if (micOn) micStop(); setMicUI(); });
  $('#turn-darts').addEventListener('click', (e) => {
    const c = e.target.closest('.chip[data-i]');
    if (c && canEdit()) openInput(Number(c.dataset.i));
  });

  // Eingabe-Dialog
  let inIndex = null, inMult = 1;
  $('#in-grid').innerHTML = Array.from({ length: 20 }, (_, i) => `<button type="button" data-n="${i + 1}">${i + 1}</button>`).join('');
  function setMult(m) {
    inMult = m;
    $$('#in-mult button').forEach((b) => b.classList.toggle('on', Number(b.dataset.m) === m));
  }
  function openInput(index) {
    inIndex = index;
    setMult(1);
    $('#in-title').textContent = index == null ? 'Wurf eingeben' : `Pfeil ${index + 1} korrigieren`;
    $('#in-delete').classList.toggle('hidden', index == null);
    $('#dlg-input').showModal();
  }
  function commitInput(d) {
    $('#dlg-input').close();
    if (mode === 'test') { testHits.push(d); renderTestHits(); speak(say(d)); return; }
    if (mode === 'learn') {
      if (inIndex == null) { learnDart(d); detector.rebaseline(); }
      else { const old = lsess.cur[inIndex]; if (old && old.auto) { detector.learnFromCorrection(old, d); addReport(old, d); } Learn.setDart(lsess, inIndex, d); renderLearnPlay(); }
      return;
    }
    if (inIndex == null) { act.dart(d); detector.rebaseline(); }
    else correctDart(inIndex, d, false);
  }
  $('#in-mult').onclick = (e) => { const b = e.target.closest('button[data-m]'); if (b) setMult(Number(b.dataset.m)); };
  $('#in-grid').onclick = (e) => { const b = e.target.closest('button[data-n]'); if (b) commitInput({ seg: Number(b.dataset.n), mult: inMult }); };
  $('#dlg-input').addEventListener('click', (e) => {
    const s = e.target.closest('button[data-special]');
    if (!s) return;
    const v = s.dataset.special;
    commitInput(v === '25' ? { seg: 25, mult: 1 } : v === 'bull' ? { seg: 25, mult: 2 } : { seg: 0, mult: 0 });
  });
  $('#in-delete').onclick = () => { $('#dlg-input').close(); if (inIndex != null) act.remove(inIndex); };

  // Einstellungen
  $('#b-settings').onclick = () => {
    $('#s-thr').value = settings.threshold;
    $('#s-thr-v').textContent = settings.threshold;
    $('#s-tip').value = settings.tipMode;
    $('#s-voice').checked = settings.voice;
    $('#s-autonext').checked = settings.autoNext;
    $('#s-track').checked = settings.autoTrack !== false;
    $('#s-automiss').checked = settings.autoMiss === true;
    $('#s-lock').checked = settings.lockCam !== false;
    renderVoices();
    $('#s-direct').checked = settings.voiceDirect !== false;
    $('#s-report-n').textContent = reports.length;
    $('#dlg-settings').showModal();
  };
  $('#s-thr').oninput = (e) => { settings.threshold = Number(e.target.value); $('#s-thr-v').textContent = settings.threshold; detector.threshold = settings.threshold; saveSettings(); };
  $('#s-tip').onchange = (e) => { settings.tipMode = e.target.value; detector.tipMode = settings.tipMode; saveSettings(); };
  $('#s-voice').onchange = (e) => { settings.voice = e.target.checked; saveSettings(); };
  function renderVoices() {
    const S = window.Speech;
    if (!S) return;
    const list = S.voices();
    const opts = [`<option value="auto">Automatisch – beste Stimme (${esc(S.currentName())})</option>`];
    if (S.cloud.enabled) opts.push(`<option value="cloud">Google Neural (Server)</option>`);
    list.forEach((v) => opts.push(`<option value="${esc(v.id)}">${esc(v.name)}${v.natural ? ' ★' : ''}</option>`));
    $('#s-voicesel').innerHTML = opts.join('');
    $('#s-voicesel').value = S.voice;
    if ($('#s-voicesel').value !== S.voice) $('#s-voicesel').value = 'auto';
    $('#s-rate').value = S.rate;
    $('#s-voicehint').textContent = list.some((v) => v.natural) || S.cloud.enabled
      ? 'Mit ★ markierte Stimmen sind natürliche (neuronale) Stimmen.'
      : 'Auf diesem Gerät gibt es keine natürliche deutsche Stimme. Tipp: In Edge gibt es „Katja (Natural)“, am iPhone unter Einstellungen → Bedienungshilfen → Gesprochene Inhalte → Stimmen eine „Premium“-Stimme laden.';
  }
  $('#s-voicesel').onchange = (e) => { window.Speech.voice = e.target.value; window.Speech.test(); };
  $('#s-rate').oninput = (e) => { window.Speech.rate = Number(e.target.value); };
  $('#s-voicetest').onclick = () => window.Speech.test();
  $('#s-direct').onchange = (e) => { settings.voiceDirect = e.target.checked; saveSettings(); };
  $('#s-autonext').onchange = (e) => { settings.autoNext = e.target.checked; saveSettings(); };
  $('#s-track').onchange = (e) => { settings.autoTrack = e.target.checked; detector.autoTrack = settings.autoTrack; saveSettings(); };
  $('#s-automiss').onchange = (e) => { settings.autoMiss = e.target.checked; detector.autoMiss = settings.autoMiss; saveSettings(); };
  $('#s-lock').onchange = async (e) => {
    settings.lockCam = e.target.checked; saveSettings();
    const ok = await lockCamera(settings.lockCam);
    if (settings.lockCam) toast(ok ? 'Belichtung & Fokus fixiert ✓' : 'Dieses Handy erlaubt das Fixieren im Browser nicht');
  };

  // ---------- Erkennung ----------
  let lastTip = null;
  const detector = new D.DartDetector({
    onDart(d, info) {
      lastTip = { u: info.u, v: info.v, t: Date.now(), label: B.label(d) };
      if (mode === 'test') { testHits.push(d); renderTestHits(); speak(say(d)); return; }
      if (mode === 'learn') { learnDart(d); return; }
      if (!game || game.finished || !myTurn() || Game.turnComplete(game)) return;
      act.dart(d);
    },
    onCleared() {
      if (mode === 'test') { testHits = []; renderTestHits(); return; }
      if (mode === 'learn') { if (lsess && lsess.cur.length && !lsess.st.finished) learnNext(); return; }
      if (!game || game.finished || !myTurn()) return;
      if (game.turn.darts.length === 0) return;
      if (settings.autoNext) act.next();
      else toast('Scheibe frei – „Weiter" drücken');
    },
    onStatus(s) { setCamStatus(s); },
    onLargeChange() { /* z. B. Licht geändert */ },
    onRealign(r) {
      saveCalib();
      if (r.moved > 2) toast('Kamera verrutscht – Raster automatisch nachgeführt ✓');
    },
    onLost() { toast('Scheibe nicht mehr gefunden – Handy prüfen oder neu kalibrieren', 4500); },
    onShift() { saveCalib(); }, // kleine Erschütterung ausgeglichen
    onBias(b) {
      saveCalib();
      toast(`Aus deinen Korrekturen gelernt: Pfeilspitze wird jetzt ${Math.abs(b).toFixed(1).replace('.', ',')} mm weiter ${b > 0 ? 'vorne' : 'hinten'} gesucht`, 5000);
    },
  });
  detector.threshold = settings.threshold;
  detector.tipMode = settings.tipMode;
  detector.autoTrack = settings.autoTrack !== false;
  detector.autoMiss = settings.autoMiss === true;
  window.DartScanDebug = { detector }; // für die Fehlersuche in der Browser-Konsole
  function saveCalib() {
    if (detector.calib) LS.set('ds.cal', { pts: detector.calib, view: detector.view, hz: detector.hz, bias: detector.tipBias || 0 });
  }
  (() => {
    const c = LS.get('ds.cal', null);
    if (c && c.pts && c.pts.length === 4) {
      detector.view = c.view || detector.view;
      detector.hz = c.hz || 1;
      detector.tipBias = c.bias || 0;
      detector.setCalibration(c.pts);
      return;
    }
    const old = LS.get('ds.calib', null); // ältere Version
    if (old && old.length === 4) detector.setCalibration(old);
  })();

  function syncDetector() {
    if (mode === 'test') { if (detector.phase !== 'throw') detector.startTurn(); return; }
    if (mode === 'learn') {
      if (!lsess || lsess.st.finished) { detector.phase = 'idle'; return; }
      const key = 'learn:' + lsess.id + ':' + lsess.rounds.length + ':' + lessonRun;
      if (key !== lastTurnKey) { lastTurnKey = key; detector.startTurn(); }
      detector.phase = lsess.st.curDone ? 'pull' : 'throw';
      return;
    }
    if (!game || game.finished || !myTurn()) {
      detector.phase = 'idle';
      if (game && !game.finished && mode === 'online') setCamStatus(`Pausiert – ${game.players[game.current].name} ist dran`);
      return;
    }
    const key = mode + ':' + game.turnId;
    if (key !== lastTurnKey) { lastTurnKey = key; detector.startTurn(); }
    detector.phase = Game.turnComplete(game) ? 'pull' : 'throw';
  }

  let lastStatusText = '';
  function setCamStatus(s) {
    if (s != null) lastStatusText = s;
    const q = detector.quality != null && detector.H && !detector.lost ? (detector.quality > 0.2 ? ' · Scheibe ✓' : ' · Scheibe schlecht sichtbar – Licht/Zoom prüfen') : '';
    $('#cam-status').textContent = !stream ? 'Kamera aus' : calib ? 'Kalibrierung …' : !detector.H ? 'Bitte kalibrieren' : lastStatusText + q;
    const dot = $('#cam-dot');
    dot.className = 'dot ' + (!stream || !detector.H ? '' : detector.lost ? 'lost' : detector.phase === 'throw' ? 'live' : 'wait');
  }

  function renderTestHits() {
    $('#test-hits').innerHTML = testHits.length
      ? testHits.map((d, i) => chipHTML(d, i, false)).join('')
      : '<span class="muted small">Noch nichts erkannt. Wirf einen Pfeil!</span>';
  }

  // ---------- Kamera ----------
  const video = $('#video');
  const canvas = $('#cam-canvas');
  const ctx = canvas.getContext('2d');
  let stream = null, raf = null, debug = false, wakeLock = null;

  async function camOn() {
    if (stream) return true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('Kamera braucht HTTPS (oder localhost).', 4000);
      return false;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
    } catch (e) {
      toast('Kamera nicht verfügbar: ' + (e.message || e.name), 4000);
      return false;
    }
    video.srcObject = stream;
    try { await video.play(); } catch (_) {}
    $('#cam-off').classList.add('hidden');
    hwCaps = null;
    try {
      const c = track().getCapabilities ? track().getCapabilities() : {};
      if (c.zoom && c.zoom.max > Math.max(1, c.zoom.min)) hwCaps = { min: Math.max(1, c.zoom.min), max: c.zoom.max };
    } catch (_) {}
    hwActual = 1;
    $('#zoom-row').classList.remove('hidden');
    await applyZoom(zoom, false);
    detector.start(video);
    requestWakeLock();
    cancelAnimationFrame(raf);
    draw();
    // Belichtung/Weißabgleich/Fokus nach kurzer Eingewöhnung fixieren: verhindert Helligkeitssprünge zwischen den Würfen
    if (settings.lockCam !== false) setTimeout(() => { if (stream) lockCamera(true); }, 2500);
    if (!detector.H) { lastStatusText = 'Kalibrierung …'; setTimeout(startCalibration, 400); }
    else { lastStatusText = 'Bereit'; setTimeout(() => showQuality(false), 1500); }
    setCamStatus();
    if (game) syncDetector();
    return true;
  }

  // Automatik der Kamera an-/ausschalten (geht v. a. bei Android/Chrome; iPhone ignoriert es)
  async function lockCamera(on) {
    const t = track();
    if (!t || !t.getCapabilities) return false;
    let c, st;
    try { c = t.getCapabilities(); st = t.getSettings(); } catch (_) { return false; }
    const adv = {};
    const has = (k, v) => Array.isArray(c[k]) && c[k].includes(v);
    if (on) {
      if (has('exposureMode', 'manual') && st.exposureTime) { adv.exposureMode = 'manual'; adv.exposureTime = st.exposureTime; }
      if (has('whiteBalanceMode', 'manual') && st.colorTemperature) { adv.whiteBalanceMode = 'manual'; adv.colorTemperature = st.colorTemperature; }
      if (has('focusMode', 'manual') && st.focusDistance != null) { adv.focusMode = 'manual'; adv.focusDistance = st.focusDistance; }
    } else {
      for (const k of ['exposureMode', 'whiteBalanceMode', 'focusMode']) if (has(k, 'continuous')) adv[k] = 'continuous';
    }
    if (!Object.keys(adv).length) return false;
    try { await t.applyConstraints({ advanced: [adv] }); return true; } catch (_) { return false; }
  }

  function camOff() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    detector.stop();
    cancelAnimationFrame(raf);
    $('#cam-off').classList.remove('hidden');
    stopCalibration();
    $('#zoom-row').classList.add('hidden');
    setCamStatus('');
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }

  async function requestWakeLock() {
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && stream) requestWakeLock(); });

  $('#b-cam-on').onclick = camOn;
  $('#b-cam-off').onclick = camOff;
  $('#b-debug').onclick = () => { debug = !debug; $('#b-debug').classList.toggle('on', debug); };
  $('#b-calib').onclick = async () => { if (await camOn()) startCalibration(); };

  // ---------- Zoom ----------
  // Zustand bezogen aufs Kamerabild OHNE Hardware-Zoom: z = Gesamtzoom, cx/cy = Mitte des Ausschnitts (0..1)
  const zoom = Object.assign({ z: 1, cx: 0.5, cy: 0.5 }, LS.get('ds.zoom', {}));
  let hwCaps = null, hwActual = 1, gestureView = null, zoomChain = Promise.resolve();
  const track = () => stream && stream.getVideoTracks()[0];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const zMax = () => (hwCaps ? Math.min(12, Math.max(5, hwCaps.max * 2)) : 5);

  function clampZoom(st, minZ = 1) {
    const z = Math.min(zMax(), Math.max(minZ, st.z));
    const half = 0.5 / z;
    return { z, cx: Math.min(1 - half, Math.max(half, st.cx)), cy: Math.min(1 - half, Math.max(half, st.cy)) };
  }
  // Ausschnitt im (eventuell hardware-gezoomten) Kamerabild
  function viewFor(st, hz) {
    const half = (0.5 / st.z) * hz;
    const hx = 0.5 + (st.cx - 0.5) * hz, hy = 0.5 + (st.cy - 0.5) * hz;
    return { x: hx - half, y: hy - half, w: 2 * half, h: 2 * half };
  }
  // so viel Hardware-Zoom wie möglich, solange der gewünschte Ausschnitt noch drin ist
  function hwFor(st) {
    if (!hwCaps) return 1;
    const need = Math.max(Math.abs(st.cx - 0.5), Math.abs(st.cy - 0.5)) + 0.5 / st.z;
    return Math.max(hwCaps.min, Math.min(hwCaps.max, st.z, 0.5 / need));
  }
  function updateZoomUI() {
    $('#z-range').max = zMax();
    $('#z-range').value = zoom.z;
    $('#z-val').textContent = zoom.z.toFixed(1).replace('.', ',') + '×' + (hwCaps && hwActual > 1.01 ? ' (optisch ' + hwActual.toFixed(1).replace('.', ',') + '×)' : '');
  }
  function applyZoom(st, save = true) {
    Object.assign(zoom, clampZoom(st));
    if (save) LS.set('ds.zoom', zoom);
    updateZoomUI();
    updateTouch();
    zoomChain = zoomChain.then(async () => {
      if (!stream) return;
      let hz = hwFor(zoom);
      if (hwCaps && Math.abs(hz - hwActual) > 0.01) {
        try { await track().applyConstraints({ advanced: [{ zoom: hz }] }); hwActual = hz; await sleep(450); }
        catch (_) { hz = hwActual; }
      } else hz = hwCaps ? hwActual : 1;
      detector.setView(viewFor(zoom, hz), hz);
      gestureView = null;
      saveCalib();
      updateZoomUI();
      setTimeout(() => showQuality(false), 400);
    });
    return zoomChain;
  }
  function zoomToBoard() {
    if (!detector.Hinv) return toast('Zuerst kalibrieren, dann kann ich auf die Scheibe zoomen');
    const v = detector.view, hz = detector.hz;
    let x0 = 1, x1 = 0, y0 = 1, y1 = 0;
    for (let a = 0; a < 360; a += 10) {
      const [u, w] = D.applyH(detector.Hinv, ...B.polar(200, a));
      const gx = 0.5 + (v.x + u * v.w - 0.5) / hz, gy = 0.5 + (v.y + w * v.h - 0.5) / hz;
      x0 = Math.min(x0, gx); x1 = Math.max(x1, gx); y0 = Math.min(y0, gy); y1 = Math.max(y1, gy);
    }
    applyZoom({ z: 0.94 / Math.max(x1 - x0, y1 - y0), cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 });
    toast('Auf die Scheibe gezoomt');
  }
  $('#z-range').oninput = (e) => { gestureView = viewFor(clampZoom({ ...zoom, z: Number(e.target.value) }, detector.hz), detector.hz); $('#z-val').textContent = Number(e.target.value).toFixed(1).replace('.', ',') + '×'; };
  $('#z-range').onchange = (e) => applyZoom({ ...zoom, z: Number(e.target.value) });
  $('#z-in').onclick = () => applyZoom({ ...zoom, z: zoom.z * 1.25 });
  $('#z-out').onclick = () => applyZoom({ ...zoom, z: zoom.z / 1.25 });
  $('#z-fit').onclick = zoomToBoard;
  $('#z-reset').onclick = () => applyZoom({ z: 1, cx: 0.5, cy: 0.5 });

  // Pinch-Zoom mit zwei Fingern, Verschieben mit einem Finger (außerhalb der Kalibrierung)
  const pointers = new Map();
  let gesture = null;
  function gestureStart() {
    const ps = [...pointers.values()];
    if (ps.length === 2) {
      const mu = [(ps[0][0] + ps[1][0]) / 2, (ps[0][1] + ps[1][1]) / 2];
      gesture = { type: 'pinch', d0: Math.hypot(ps[0][0] - ps[1][0], ps[0][1] - ps[1][1]) || 0.01, st: { ...zoom }, mu };
    } else if (ps.length === 1 && zoom.z > 1.01) gesture = { type: 'pan', p0: ps[0], st: { ...zoom } };
    else gesture = null;
  }
  function gestureMove() {
    if (!gesture) return;
    const ps = [...pointers.values()];
    let st;
    if (gesture.type === 'pinch' && ps.length === 2) {
      const z = gesture.st.z * Math.hypot(ps[0][0] - ps[1][0], ps[0][1] - ps[1][1]) / gesture.d0;
      const m1x = gesture.st.cx + (gesture.mu[0] - 0.5) / gesture.st.z, m1y = gesture.st.cy + (gesture.mu[1] - 0.5) / gesture.st.z;
      st = { z, cx: m1x - (gesture.mu[0] - 0.5) / z, cy: m1y - (gesture.mu[1] - 0.5) / z };
    } else if (gesture.type === 'pan' && ps.length === 1) {
      st = { z: gesture.st.z, cx: gesture.st.cx - (ps[0][0] - gesture.p0[0]) / gesture.st.z, cy: gesture.st.cy - (ps[0][1] - gesture.p0[1]) / gesture.st.z };
    } else return;
    gesture.last = clampZoom(st);
    gestureView = viewFor(clampZoom(st, detector.hz), detector.hz);
  }
  function gestureEnd() {
    if (gesture && gesture.last) applyZoom(gesture.last);
    gesture = null;
  }

  // Debug-Maske
  const maskCanvas = document.createElement('canvas');
  const maskCtx = maskCanvas.getContext('2d');
  let maskTime = 0;
  function drawMask(W, H) {
    const now = performance.now();
    if (now - maskTime > 150) {
      maskTime = now;
      const m = detector.debugMask();
      if (m) {
        maskCanvas.width = m.w; maskCanvas.height = m.h;
        const img = maskCtx.createImageData(m.w, m.h);
        for (let i = 0; i < m.bin.length; i++) if (m.bin[i]) { img.data[i * 4] = 255; img.data[i * 4 + 1] = 40; img.data[i * 4 + 3] = 200; }
        maskCtx.putImageData(img, 0, 0);
      }
    }
    if (maskCanvas.width) ctx.drawImage(maskCanvas, 0, 0, W, H);
  }

  function drawGrid(Hinv, W, H, alpha, dpr) {
    if (!Hinv) return;
    const P = (x, y) => { const [u, v] = D.applyH(Hinv, x, y); return [u * W, v * H]; };
    ctx.save();
    ctx.strokeStyle = `rgba(242,193,78,${alpha})`;
    ctx.lineWidth = 1.4 * dpr;
    for (const r of [B.R.bullIn, B.R.bullOut, B.R.trebleIn, B.R.trebleOut, B.R.doubleIn, B.R.doubleOut]) {
      ctx.beginPath();
      for (let a = 0; a <= 360; a += 4) {
        const [x, y] = P(...B.polar(r, a));
        a === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.beginPath();
    for (let i = 0; i < 20; i++) {
      const [x1, y1] = P(...B.polar(B.R.bullOut, i * 18 - 9));
      const [x2, y2] = P(...B.polar(B.R.doubleOut, i * 18 - 9));
      ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    }
    ctx.stroke();
    ctx.fillStyle = `rgba(242,193,78,${Math.min(1, alpha + 0.3)})`;
    ctx.font = `700 ${13 * dpr}px system-ui`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    B.ORDER.forEach((n, i) => { const [x, y] = P(...B.polar(190, i * 18)); ctx.fillText(n, x, y); });
    ctx.restore();
  }

  function draw() {
    raf = requestAnimationFrame(draw);
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return;
    const cw = canvas.clientWidth || 320;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(cw * dpr), H = Math.round(((cw * vh) / vw) * dpr);
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W; canvas.height = H;
      canvas.style.height = (cw * vh) / vw + 'px';
    }
    const view = gestureView || detector.view;
    ctx.drawImage(video, view.x * vw, view.y * vh, view.w * vw, view.h * vh, 0, 0, W, H);
    if (gestureView) return; // während des Zoomens keine Overlays (Raster passt erst danach)
    if (debug && !calib) drawMask(W, H);
    if (calib) drawCalib(W, H, dpr);
    else drawGrid(detector.Hinv, W, H, debug ? 0.7 : 0.28, dpr);
    if (lastTip && Date.now() - lastTip.t < 3500 && !calib) {
      const x = lastTip.u * W, y = lastTip.v * H;
      ctx.save();
      ctx.strokeStyle = '#ece0bf'; ctx.lineWidth = 3 * dpr;
      ctx.beginPath(); ctx.arc(x, y, 9 * dpr, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = 'rgba(0,0,0,.7)';
      ctx.font = `800 ${18 * dpr}px "Big Shoulders Display", system-ui`;
      const tw = ctx.measureText(lastTip.label).width;
      ctx.fillRect(x + 12 * dpr, y - 14 * dpr, tw + 12 * dpr, 26 * dpr);
      ctx.fillStyle = '#ece0bf';
      ctx.fillText(lastTip.label, x + 18 * dpr, y + 6 * dpr);
      ctx.restore();
    }
  }

  // ---------- Kalibrierung ----------
  const PROMPTS = [
    'Tippe auf den äußeren Rand des Doppelrings genau mittig über der <b>20</b> (oben)',
    'Jetzt den äußeren Doppelring-Rand mittig bei der <b>6</b> (rechts)',
    '… mittig bei der <b>3</b> (unten)',
    '… mittig bei der <b>11</b> (links)',
  ];
  // mode: 'search' (sucht) | 'review' (automatisch gefunden) | 'manual' (4 Punkte tippen)
  let calib = null;
  const pct = (q) => Math.round(Math.min(1, q / 0.45) * 100);

  function startCalibration() {
    calib = { pts: [], drag: -1, mode: 'search', quality: null };
    updateTouch();
    $('#cam-tools').classList.add('hidden');
    $('#calib-tools').classList.remove('hidden');
    runAutoCalib(0);
  }
  function runAutoCalib(attempt) {
    if (!calib) return;
    calib.mode = 'search';
    calib.pts = [];
    updateCalibHint();
    setTimeout(() => {
      if (!calib) return;
      const r = detector.autoCalibrate();
      if (r) {
        calib.pts = r.pts; calib.quality = r.quality; calib.mode = 'review';
      } else if (attempt < 6 && !detector.rgba) {
        return runAutoCalib(attempt + 1); // Kamera liefert noch kein Bild
      } else {
        calib.mode = 'manual';
        toast('Scheibe nicht automatisch gefunden – bitte die 4 Punkte antippen', 4000);
      }
      updateCalibHint();
    }, attempt ? 400 : 60);
  }
  function startManual() {
    calib = calib || { drag: -1 };
    calib.pts = []; calib.mode = 'manual'; calib.quality = null;
    updateCalibHint();
  }
  // Wischen über das Kamerabild scrollt die Seite – außer beim Kalibrieren und wenn gezoomt (dann verschiebt es den Ausschnitt)
  function updateTouch() { canvas.classList.toggle('capture', !!calib || zoom.z > 1.01); }
  function stopCalibration() {
    calib = null;
    setTimeout(updateTouch, 0);
    $('#cam-tools').classList.remove('hidden');
    $('#calib-tools').classList.add('hidden');
    $('#cam-hint').classList.add('hidden');
  }
  function updateCalibHint() {
    const h = $('#cam-hint');
    h.classList.remove('hidden');
    if (calib.mode === 'search') h.innerHTML = 'Suche die Scheibe …';
    else if (calib.mode === 'review') h.innerHTML = `Scheibe erkannt ✓ (${pct(calib.quality)} %). Steht die <b>20</b> richtig? Sonst <b>tippe auf die echte 20</b>. Dann <b>Fertig</b>.`;
    else if (calib.pts.length < 4) h.innerHTML = PROMPTS[calib.pts.length];
    else h.innerHTML = 'Das gelbe Raster muss auf den Drähten liegen. Punkte bei Bedarf ziehen, dann <b>Fertig</b>.';
    $('#c-done').disabled = calib.pts.length < 4;
  }
  $('#c-auto').onclick = () => runAutoCalib(0);
  $('#c-manual').onclick = startManual;
  $('#c-cancel').onclick = () => { stopCalibration(); setCamStatus('Bereit'); };
  $('#c-done').onclick = () => {
    const pts = calib.pts;
    if (!D.solveH(pts, D.CAL_DST)) return toast('Punkte ungültig – bitte neu setzen');
    detector.setCalibration(pts);
    detector.tipBias = 0; detector.biasSamples = []; // neue Kameraposition: neu lernen
    const q = detector.refineCalibration(pts);
    detector.quality = q ? q.quality : null;
    saveCalib();
    stopCalibration();
    lastTurnKey = null;
    if (game) syncDetector(); else if (mode === 'test') detector.startTurn();
    showQuality(true);
  };

  // Wie genau kann diese Kameraposition messen? Anzeige + konkreter Tipp
  function showQuality(withToast) {
    const q = detector.qualityInfo();
    const el = $('#cam-quality');
    if (!q) { el.classList.add('hidden'); return; }
    const labels = ['grob', 'ok', 'gut', 'sehr gut'];
    el.className = 'quality q' + q.level;
    LS.set('ds.calq', q.level);
    el.textContent = `Genauigkeit ${labels[q.level]} (±${(q.mmPerPx * 0.8).toFixed(1).replace('.', ',')} mm)`;
    if (!withToast) return;
    let tip = '';
    if (q.level <= 1) {
      if (q.angle != null && q.angle > 55) tip = 'Das Handy steht sehr flach zur Scheibe – etwas mehr nach vorne stellen (30–50° sind ideal).';
      else if (detector.view.w > 0.8) tip = 'Tippe auf „Auf Scheibe“, damit die Scheibe das Bild ausfüllt.';
      else tip = 'Handy näher an die Scheibe stellen, damit sie größer im Bild ist.';
    }
    toast(`Kalibriert ✓ – Genauigkeit ${labels[q.level]}${tip ? '. ' + tip : ''}`, tip ? 6500 : 3000);
  }
  window.DS.showQuality = showQuality;

  // manuell gesetzte Punkte an den Farbringen „einrasten“
  function snapManual() {
    const r = detector.refineCalibration(calib.pts);
    if (r && r.quality > 0.15) { calib.pts = r.pts; calib.quality = r.quality; toast('Punkte an den Ringen ausgerichtet ✓'); }
  }

  function toUV(e) {
    const r = canvas.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  }
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const uv = toUV(e);
    if (!calib || calib.mode === 'search') {
      pointers.set(e.pointerId, uv);
      canvas.setPointerCapture(e.pointerId);
      gestureStart();
      return;
    }
    const r = canvas.getBoundingClientRect();
    calib.drag = -1;
    if (calib.mode === 'manual' && calib.pts.length < 4) {
      calib.pts.push(uv.slice());
      calib.drag = calib.pts.length - 1;
    } else {
      let best = -1, bd = Infinity;
      calib.pts.forEach((p, i) => {
        const d = Math.hypot((p[0] - uv[0]) * r.width, (p[1] - uv[1]) * r.height);
        if (d < bd) { bd = d; best = i; }
      });
      if (bd <= 40) calib.drag = best;
      else if (calib.mode === 'review') {
        // auf die echte 20 getippt -> Raster drehen und neu einpassen
        const turned = window.BoardFinder.reorient(calib.pts, uv);
        const ref = detector.refineCalibration(turned);
        calib.pts = ref && ref.quality > 0.1 ? ref.pts : turned;
        toast('Ausrichtung geändert – passt die 20 jetzt?');
        return;
      } else return;
    }
    calib.start = uv;
    calib.orig = calib.pts[calib.drag].slice();
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) { pointers.set(e.pointerId, toUV(e)); gestureMove(); return; }
    if (!calib || calib.drag < 0) return;
    const uv = toUV(e);
    calib.pts[calib.drag] = [calib.orig[0] + uv[0] - calib.start[0], calib.orig[1] + uv[1] - calib.start[1]];
  });
  const endDrag = (e) => {
    if (pointers.has(e.pointerId)) {
      pointers.delete(e.pointerId);
      if (pointers.size === 0) gestureEnd(); else gestureStart();
      return;
    }
    if (calib && calib.drag >= 0) {
      const wasNew = calib.mode === 'manual' && calib.drag === 3 && calib.pts.length === 4 && !calib.snapped;
      calib.drag = -1;
      if (wasNew) { calib.snapped = true; snapManual(); }
      updateCalibHint();
    }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  function drawCalib(W, H, dpr) {
    if (calib.pts.length === 4) {
      const Hm = D.solveH(calib.pts, D.CAL_DST);
      drawGrid(Hm && D.invertH(Hm), W, H, 0.85, dpr);
    }
    const names = ['20', '6', '3', '11'];
    calib.pts.forEach((p, i) => {
      const x = p[0] * W, y = p[1] * H;
      ctx.save();
      ctx.strokeStyle = i === calib.drag ? '#fff' : '#22a05a';
      ctx.lineWidth = 2.5 * dpr;
      ctx.beginPath(); ctx.arc(x, y, 11 * dpr, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - 5 * dpr, y); ctx.lineTo(x + 5 * dpr, y); ctx.moveTo(x, y - 5 * dpr); ctx.lineTo(x, y + 5 * dpr); ctx.stroke();
      ctx.fillStyle = '#22a05a';
      ctx.font = `700 ${13 * dpr}px system-ui`;
      ctx.fillText(names[i], x + 14 * dpr, y - 12 * dpr);
      ctx.restore();
    });
    // Lupe beim Ziehen
    if (calib.drag >= 0) {
      const p = calib.pts[calib.drag], view = detector.view;
      const vw = video.videoWidth, vh = video.videoHeight;
      const R = 70 * dpr, mag = 3;
      const cx = p[0] < 0.5 ? W - R - 10 * dpr : R + 10 * dpr, cy = R + 10 * dpr;
      const sw = ((2 * R) / mag) * ((vw * view.w) / W), sh = ((2 * R) / mag) * ((vh * view.h) / H);
      const px = (view.x + p[0] * view.w) * vw, py = (view.y + p[1] * view.h) * vh;
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
      ctx.drawImage(video, px - sw / 2, py - sh / 2, sw, sh, cx - R, cy - R, 2 * R, 2 * R);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = '#ece0bf'; ctx.lineWidth = 3 * dpr;
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    }
  }


  // ---------- Lernmodus ----------
  const Learn = window.Learn;
  let lprog = LS.get('ds.learn', {});
  let lsess = null, lessonRun = 0;
  const starSvg = (on) => `<svg viewBox="0 0 24 24" class="star ${on ? 'on' : ''}" aria-hidden="true"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z"/></svg>`;
  const stars = (n) => [1, 2, 3].map((i) => starSvg(i <= n)).join('');

  function renderLearnList() {
    const lvl = Learn.level(lprog), tot = Learn.totalStars(lprog), max = Learn.LESSONS.length * 3;
    const rank = lvl ? Learn.STAGES[lvl - 1].name : 'Neuling';
    const nextL = Learn.LESSONS.find((l) => !(lprog[l.id] && lprog[l.id].stars > 0));
    let h = `<div class="lv-card">
      <div class="lv-badge">${lvl || '–'}</div>
      <div class="lv-info"><small>Dein Level</small><b>${rank}</b><span>${tot} / ${max} Sterne</span></div>
      ${nextL ? `<button class="btn cta" id="lv-go">Weiter lernen</button>` : '<span class="lv-done">Alles gemeistert 🏆</span>'}
    </div>
    <div class="lv-path">${Learn.STAGES.map((S) => `<span class="${S.id <= lvl ? 'on' : ''}">${S.name}</span>`).join('')}</div>`;
    for (const S of Learn.STAGES) {
      const ls = Learn.LESSONS.filter((l) => l.stage === S.id);
      h += `<div class="stage"><div class="stage-head"><b>Stufe ${S.id}: ${S.name}</b><small>${S.sub}</small></div>`;
      for (const L of ls) {
        const p = lprog[L.id], open = Learn.unlocked(lprog, L.id);
        h += `<button class="lesson ${open ? '' : 'locked'} ${p && p.stars ? 'done' : ''}" data-l="${L.id}" ${open ? '' : 'disabled'}>
          <span class="l-main"><b>${esc(L.title)}</b><small>${esc(L.goal)}</small></span>
          <span class="l-side">${open ? `<span class="stars">${stars(p ? p.stars : 0)}</span>` : '<svg viewBox="0 0 24 24" class="lock" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>'}</span>
        </button>`;
      }
      h += `</div>`;
    }
    $('#learn-body').innerHTML = h;
    const go = $('#lv-go'); if (go) go.onclick = () => startLesson(nextL.id);
  }
  $('#learn-body').addEventListener('click', (e) => { const b = e.target.closest('.lesson[data-l]'); if (b && !b.disabled) startLesson(b.dataset.l); });

  function startLesson(id) {
    if (!payRound('training')) return;
    lsess = Learn.create(id);
    lessonRun++;
    mode = 'learn'; game = null; lastTurnKey = null;
    const L = Learn.byId[id];
    $('#lp-title').textContent = L.title;
    $('#lp-stage').textContent = 'Stufe ' + L.stage + ' · ' + Learn.STAGES[L.stage - 1].name;
    $('#lp-coach-body').innerHTML = `<p class="lp-goal">${esc(L.goal)}</p><ul>${L.coach.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`;
    show('learnplay');
    renderLearnPlay();
    speak(L.title, { force: false });
    if (!stream) toast('Tipp: Kamera starten – oder Würfe mit „Eingeben“ eintragen.');
  }

  function renderLearnPlay() {
    if (!lsess) return;
    const L = Learn.byId[lsess.id], st = lsess.st;
    let label = 'Ziel', val = st.target, sub = '';
    if (L.type === 'atc') { label = 'Triff die'; sub = 'Single, Doppel oder Triple'; }
    if (L.type === 'score') { label = 'Ziel'; val = 'T20'; sub = 'Möglichst viele Punkte auf die 20'; }
    if (L.type === 'checkout' || L.type === 'x01') {
      label = L.type === 'x01' ? '501 – Rest' : 'Checkout';
      const co = st.rest > 0 && !st.curDone ? Game.checkout(st.rest, st.info.dartsLeft, true) : null;
      sub = st.curDone && L.type === 'checkout' ? (st.results[lsess.rounds.length].out === 'ok' ? 'Checkout! ✓ Pfeile ziehen' : 'Nicht geschafft – Pfeile ziehen') : co ? 'Weg: ' + co.join(' · ') : st.rest > 0 ? 'Kein Finish möglich – stell dir ein Doppel' : '';
    }
    if (L.type === 'hits') sub = L.target.any ? 'Hauptsache auf der Scheibe' : 'Jeder Treffer zählt';
    $('#lp-tlabel').textContent = label;
    $('#lp-tval').textContent = val;
    $('#lp-tsub').textContent = sub;
    $('#lp-bar').style.width = Math.round(st.progress * 100) + '%';
    $('#lp-metric').textContent = st.metric;
    $('#lp-need').textContent = st.need;
    $('#lp-darts').innerHTML = [0, 1, 2].map((i) => chipHTML(lsess.cur[i], i, true)).join('');
    $('#lp-next').disabled = !lsess.cur.length || st.finished;
    $('#lp-undo').disabled = !lsess.cur.length && !lsess.rounds.length;
    $('#lp-miss').disabled = st.curDone || st.finished;
    $('#lp-manual').disabled = st.curDone || st.finished;
    syncDetector();
    if (st.finished) setTimeout(learnFinished, 700);
  }

  function learnDart(d) {
    if (!lsess || lsess.st.finished || lsess.st.curDone) return;
    const L = Learn.byId[lsess.id];
    const before = lsess.st;
    if (!Learn.addDart(lsess, d)) return;
    const st = lsess.st, parts = [say(d)];
    if (L.type === 'atc' && st.info.pos > before.info.pos) { parts.length = 0; parts.push(st.info.pos >= L.seq.length ? 'Geschafft!' : String(st.target)); }
    if (L.type === 'checkout' && st.curDone) { const r = st.results[lsess.rounds.length]; parts.push(r.out === 'ok' ? 'Checkout!' : r.out === 'bust' ? 'Überworfen' : ''); }
    if (L.type === 'x01' && st.curBust) parts.push('Überworfen');
    if (L.type === 'x01' && st.rest === 0) parts.push('Game shot!');
    if (L.type === 'score' && lsess.cur.length === 3) { const t = lsess.cur.reduce((a, x) => a + x.value, 0); parts.push(t === 180 ? 'Hundertachtzig!' : String(t)); }
    speak(parts.filter(Boolean));
    renderLearnPlay();
    const chip = $(`#lp-darts .chip[data-i="${lsess.cur.length - 1}"]`); if (chip) chip.classList.add('flash');
  }
  function learnNext() { if (lsess && Learn.next(lsess)) renderLearnPlay(); }

  let learnShown = null;
  function learnFinished() {
    if (!lsess || !lsess.st.finished || learnShown === lessonRun || screen !== 'learnplay') return;
    learnShown = lessonRun;
    const L = Learn.byId[lsess.id], st = lsess.st;
    const wasOpen = Learn.LESSONS.map((l) => Learn.unlocked(lprog, l.id));
    Learn.record(lprog, lsess.id, st);
    LS.set('ds.learn', lprog);
    window.Account && window.Account.saveLearn && window.Account.saveLearn(lprog);
    const idx = Learn.LESSONS.findIndex((l) => l.id === lsess.id);
    const nextL = Learn.LESSONS[idx + 1];
    const newly = nextL && !wasOpen[idx + 1] && Learn.unlocked(lprog, nextL.id);
    $('#lr-stars').innerHTML = stars(st.stars);
    $('#lr-title').textContent = st.passed ? (st.stars === 3 ? 'Perfekt!' : 'Bestanden!') : 'Noch nicht geschafft';
    $('#lr-text').textContent = Learn.resultText(lsess) + (st.passed ? '' : ' – ' + L.goal.replace(/\.$/, '') + '.');
    const lvlUp = newly && nextL.stage > L.stage;
    $('#lr-unlock').classList.toggle('hidden', !newly);
    $('#lr-unlock').textContent = lvlUp ? `Neue Stufe erreicht: ${Learn.STAGES[L.stage - 1].name} geschafft! Weiter mit „${nextL.title}“` : newly ? `Freigeschaltet: ${nextL.title}` : '';
    $('#lr-next').classList.toggle('hidden', !(nextL && Learn.unlocked(lprog, nextL.id)));
    $('#lr-next').onclick = () => { $('#dlg-learn').close(); startLesson(nextL.id); };
    $('#lr-again').onclick = () => { $('#dlg-learn').close(); startLesson(lsess.id); };
    $('#lr-list').onclick = () => { $('#dlg-learn').close(); openLearn(); };
    speak(st.passed ? (lvlUp ? ['Bestanden!', 'Neue Stufe erreicht'] : 'Bestanden!') : 'Noch nicht geschafft', { force: false });
    $('#dlg-learn').showModal();
  }

  function openLearn() { mode = null; lsess = null; detector.phase = 'idle'; renderLearnList(); show('learn'); }
  $('#go-learn').onclick = openLearn;
  $('#lp-back').onclick = openLearn;
  $('#lp-manual').onclick = () => openInput(null);
  $('#lp-miss').onclick = () => { learnDart({ seg: 0, mult: 0 }); detector.rebaseline(); };
  $('#lp-undo').onclick = () => { if (lsess && Learn.undo(lsess)) { lastTurnKey = null; renderLearnPlay(); } };
  $('#lp-next').onclick = learnNext;
  $('#lp-darts').addEventListener('click', (e) => { const c = e.target.closest('.chip[data-i]'); if (c && lsess && !lsess.st.finished) openInput(Number(c.dataset.i)); });
  function learnTile() {
    const lvl = Learn.level(lprog), tot = Learn.totalStars(lprog);
    $('#learn-tile-status').textContent = tot ? `${lvl ? Learn.STAGES[lvl - 1].name : 'Stufe 1'} · ${tot} ★` : 'Vom Anfänger zum Profi';
  }
  hooks.home.push(learnTile);

  // ---------- Online ----------
  function send(m) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(m));
    else toast('Keine Verbindung zum Server …');
  }

  function connect() {
    return new Promise((resolve, reject) => {
      if (ws && ws.readyState === 1) return resolve();
      const sock = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
      ws = sock;
      sock.onopen = () => {
        clearInterval(pingTimer);
        pingTimer = setInterval(() => send({ t: 'ping' }), 25000);
        resolve();
      };
      sock.onerror = () => reject(new Error('Verbindung fehlgeschlagen'));
      sock.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (_) { return; } onServer(m); };
      sock.onclose = () => {
        if (ws !== sock) return;
        ws = null;
        clearInterval(pingTimer);
        if ((mode === 'online' && room) || tourn) { toast('Verbindung weg – verbinde neu …'); setTimeout(reconnect, 1500); }
      };
    });
  }

  async function reconnect() {
    const tsaved = JSON.parse(sessionStorage.getItem('ds.tourn') || 'null');
    if (tsaved) {
      try { await connect(); send({ t: 'trejoin', code: tsaved.code, id: tsaved.id }); }
      catch (_) { setTimeout(reconnect, 3000); }
      return;
    }
    const saved = JSON.parse(sessionStorage.getItem('ds.online') || 'null');
    if (!saved || mode !== 'online') return;
    try { await connect(); send({ t: 'rejoin', code: saved.code, id: saved.id }); }
    catch (_) { setTimeout(reconnect, 3000); }
  }

  function onServer(m) {
    switch (m.t) {
      case 'joined':
        myId = m.id;
        sessionStorage.setItem('ds.online', JSON.stringify({ code: m.code, id: m.id }));
        break;
      case 'room': {
        const wasGame = !!game && mode === 'online';
        mode = 'online';
        room = m.room;
        const prevTurn = game && game.turnId;
        game = room.game;
        // jedes neue Online-Spiel (auch Revanche / Turnier-Match) kostet einen Coin
        if (game && game.id !== paidGameId && game.players.some((p) => p.id === myId)) { paidGameId = game.id; Coins.spend(1, room.tourn ? 'turnier' : 'online'); }
        if (game) {
          if (!wasGame || screen !== 'game') { lastTurnKey = null; winShownFor = null; resetAnnounce(); show('game'); }
          if (prevTurn && game.turnId < prevTurn) winShownFor = null; // Revanche
          update();
        } else {
          if ($('#dlg-win').open) $('#dlg-win').close();
          show('lobby');
          renderLobby();
        }
        break;
      }
      case 'error':
        toast(m.msg);
        break;
      case 'tjoined':
        tId = m.id;
        sessionStorage.setItem('ds.tourn', JSON.stringify({ code: m.code, id: m.id }));
        if (mode !== 'online') mode = 'tourn';
        break;
      case 'tourn': {
        const first = !tourn;
        tourn = m.tourn;
        if (first || (mode !== 'online' && screen !== 'game')) { if (mode !== 'online') mode = 'tourn'; }
        if (screen === 'tlobby' || screen === 'tourn' || (first && screen !== 'game')) { renderTLobby(); if (screen !== 'tlobby') show('tlobby'); }
        else if (screen === 'tlobby') renderTLobby();
        break;
      }
      case 'tmatchdone':
        room = null; game = null; myId = null; mode = 'tourn';
        sessionStorage.removeItem('ds.online');
        if ($('#dlg-win').open) $('#dlg-win').close();
        detector.phase = 'idle';
        speak(m.won ? 'Match gewonnen!' : 'Match verloren', { force: false });
        toast(m.won ? 'Match gewonnen! 🎯 Du bist weiter.' : `${m.winnerName} gewinnt das Match.`, 4500);
        renderTLobby(); show('tlobby');
        break;
      case 'tgone':
        toast('Das Turnier existiert nicht mehr.');
        leaveTourn(true); goHome(true);
        break;
      case 'gone':
        toast('Der Raum existiert nicht mehr.');
        leaveOnline();
        goHome(true);
        break;
    }
  }

  function renderLobby() {
    const host = room.hostId === myId;
    $('#lobby-code').textContent = room.code;
    $('#lobby-players').innerHTML = room.players
      .map((p) => `<li><span>${esc(p.name)}${p.id === myId ? ' <span class="muted">(du)</span>' : ''}</span>${p.id === room.hostId ? '<span class="tag">Host</span>' : p.online ? '' : '<span class="off">offline</span>'}</li>`)
      .join('');
    renderGameSettings($('#lobby-settings'), host);
    $('#lobby-start').classList.toggle('hidden', !host);
    $('#lobby-wait').classList.toggle('hidden', host);
  }

  function leaveOnline() {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'leave' }));
    const s = ws; ws = null;
    if (s) try { s.close(); } catch (_) {}
    clearInterval(pingTimer);
    sessionStorage.removeItem('ds.online');
    room = null; myId = null;
    if (mode === 'online') { mode = null; game = null; }
  }

  function getName() {
    const n = $('#on-name').value.trim();
    if (!n) { toast('Bitte zuerst deinen Namen eingeben'); $('#on-name').focus(); return null; }
    settings.name = n; saveSettings();
    return n;
  }
  $('#on-create').onclick = async () => {
    const name = getName(); if (!name) return;
    try { await connect(); mode = 'online'; send({ t: 'create', name }); } catch (e) { toast(e.message); }
  };
  $('#on-join').onclick = async () => {
    const name = getName(); if (!name) return;
    const code = $('#on-code').value.trim().toUpperCase();
    if (code.length !== 4) return toast('Der Code hat 4 Zeichen');
    try { await connect(); mode = 'online'; send({ t: 'join', code, name }); } catch (e) { toast(e.message); }
  };
  $('#on-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#on-join').click(); });
  $('#lobby-start').onclick = () => send({ t: 'start', startScore: settings.startScore, doubleOut: settings.doubleOut });
  $('#lobby-leave').onclick = () => { leaveOnline(); goHome(true); };
  $('#copy-link').onclick = async () => {
    const url = location.origin + location.pathname + '?raum=' + room.code;
    try {
      if (navigator.share) await navigator.share({ title: 'DartScan', text: 'Spiel mit mir Darts! Raum ' + room.code, url });
      else { await navigator.clipboard.writeText(url); toast('Link kopiert'); }
    } catch (_) {}
  };


  // ---------- Turnier ----------
  const tOpts = Object.assign({ startScore: 501, legs: 1, doubleOut: true }, LS.get('ds.topts', {}));
  function renderTOpts() {
    $$('#t-score button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === tOpts.startScore));
    $$('#t-legs button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === tOpts.legs));
    $$('#t-out button').forEach((b) => b.classList.toggle('on', String(tOpts.doubleOut) === b.dataset.v));
  }
  const segPick = (sel, key, conv) => { $(sel).onclick = (e) => { const b = e.target.closest('button[data-v]'); if (!b) return; tOpts[key] = conv(b.dataset.v); LS.set('ds.topts', tOpts); renderTOpts(); }; };
  segPick('#t-score', 'startScore', Number); segPick('#t-legs', 'legs', Number); segPick('#t-out', 'doubleOut', (v) => v === 'true');
  function tGetName() {
    const n = $('#t-name').value.trim();
    if (!n) { toast('Bitte zuerst deinen Namen eingeben'); $('#t-name').focus(); return null; }
    settings.name = n; saveSettings();
    return n;
  }
  $('#go-tourn').onclick = () => { $('#t-name').value = settings.name || (window.Account && window.Account.user ? window.Account.user.name.split(' ')[0] : ''); renderTOpts(); if (tourn) { renderTLobby(); show('tlobby'); } else show('tourn'); };
  $('#t-create').onclick = async () => {
    const name = tGetName(); if (!name) return;
    try { await connect(); send({ t: 'tcreate', name, ...tOpts }); show('tlobby'); } catch (e) { toast(e.message); }
  };
  $('#t-join').onclick = async () => {
    const name = tGetName(); if (!name) return;
    const code = $('#t-code').value.trim().toUpperCase();
    if (code.length !== 4) return toast('Der Code hat 4 Zeichen');
    try { await connect(); send({ t: 'tjoin', code, name }); } catch (e) { toast(e.message); }
  };
  $('#t-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#t-join').click(); });
  $('#tl-start').onclick = () => send({ t: 'tstart' });
  $('#tl-leave').onclick = () => goHome(false);
  $('#tl-play').onclick = () => { if (room && game) show('game'); };
  $('#b-tree').onclick = () => { renderTLobby(); show('tlobby'); };
  $('#tl-share').onclick = async () => {
    const url = location.origin + location.pathname + '?turnier=' + tourn.code;
    try {
      if (navigator.share) await navigator.share({ title: 'DartScan Turnier', text: 'Mach mit beim Dart-Turnier! Code ' + tourn.code, url });
      else { await navigator.clipboard.writeText(url); toast('Link kopiert'); }
    } catch (_) {}
  };

  function leaveTourn(silent) {
    if (!silent && ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'tleave' }));
    sessionStorage.removeItem('ds.tourn');
    tourn = null; tId = null;
    if (mode === 'tourn') mode = null;
  }

  const roundName = (r, n) => (r === n - 1 ? 'Finale' : r === n - 2 ? 'Halbfinale' : r === n - 3 ? 'Viertelfinale' : 'Runde ' + (r + 1));
  function renderTLobby() {
    if (!tourn) return;
    const T = tourn, host = T.hostId === tId;
    const nm = (id) => { const p = T.players.find((x) => x.id === id); return p ? p.name : ''; };
    $('#tl-title').textContent = T.status === 'done' ? 'Turnier beendet' : 'Turnier';
    $('#tl-mode').textContent = `${T.opts.startScore} · ${T.opts.doubleOut ? 'Double-Out' : 'Single-Out'} · ${T.opts.legs === 1 ? '1 Leg' : 'Best of ' + (T.opts.legs * 2 - 1)}`;
    $('#tl-code').textContent = T.code;
    $('#tl-codebox').classList.toggle('hidden', T.status !== 'lobby');
    // Status
    let st = '';
    if (T.status === 'lobby') st = `<div class="tl-info">Teile den Code – ${T.players.length} von max. 16 Spielern dabei.</div>`;
    else if (T.status === 'running') {
      const mine = T.rounds.flat().find((m) => (m.a === tId || m.b === tId) && m.status !== 'bye' && m.status !== 'done');
      const out = T.rounds.flat().some((m) => m.status === 'done' && (m.a === tId || m.b === tId) && m.winner !== tId);
      st = out ? `<div class="tl-info">Du bist ausgeschieden – schau zu, wie es weitergeht.</div>`
        : mine && mine.status === 'live' ? `<div class="tl-info live">Dein Match läuft: gegen ${esc(nm(mine.a === tId ? mine.b : mine.a))}</div>`
        : mine ? `<div class="tl-info">Warte auf deinen nächsten Gegner …</div>` : '';
    } else if (T.status === 'done') {
      st = `<div class="tl-champ"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4"/></svg><small>Turniersieger</small><b>${esc(nm(T.champion))}</b>${T.champion === tId ? '<span>Glückwunsch! 🏆</span>' : ''}</div>`;
    }
    $('#tl-status').innerHTML = st;
    // Spieler
    $('#tl-count').textContent = `(${T.players.length})`;
    $('#tl-players').innerHTML = T.players.map((p) => `<li><span>${esc(p.name)}${p.id === tId ? ' <span class="muted">(du)</span>' : ''}</span>${p.id === T.hostId ? '<span class="tag">Leitung</span>' : p.online ? '' : '<span class="off">offline</span>'}</li>`).join('');
    $('#tl-players-panel').classList.toggle('hidden', T.status !== 'lobby');
    // Turnierbaum
    const R = T.rounds.length;
    $('#tl-bracket').innerHTML = R ? T.rounds.map((round, r) => `<div class="b-round"><div class="b-title">${roundName(r, R)}</div>${round.map((m) => {
      const row = (pid, legs, sc) => {
        const cls = [pid === tId ? 'me' : '', m.winner && pid === m.winner ? 'win' : '', m.winner && pid && pid !== m.winner ? 'lose' : ''].join(' ');
        const turn = m.status === 'live' && m.live && m.live.turn === pid;
        return `<div class="b-p ${cls}"><span class="b-n">${pid ? esc(nm(pid)) : m.status === 'bye' ? '<i>Freilos</i>' : '<i>offen</i>'}${turn ? '<i class="b-turn"></i>' : ''}</span>${m.status === 'live' && sc != null ? `<span class="b-sc">${sc}</span>` : ''}<span class="b-l">${m.status === 'bye' || (m.status !== 'done' && T.opts.legs === 1) ? '' : legs}</span></div>`;
      };
      const walk = host && m.status === 'live' ? `<div class="b-walk"><button data-walk="${m.id}" data-w="${m.a}">Sieg ${esc(nm(m.a))}</button><button data-walk="${m.id}" data-w="${m.b}">Sieg ${esc(nm(m.b))}</button></div>` : '';
      return `<div class="b-m ${m.status}">${m.status === 'live' ? '<span class="b-live">live</span>' : ''}${row(m.a, m.legsA, m.live && m.live.a)}${row(m.b, m.legsB, m.live && m.live.b)}${walk}</div>`;
    }).join('')}</div>`).join('') : '';
    $('#tl-bracket').classList.toggle('hidden', !R);
    $('#tl-start').classList.toggle('hidden', !(host && T.status === 'lobby'));
    $('#tl-start').disabled = T.players.length < 2;
    $('#tl-start').textContent = T.players.length < 2 ? 'Warte auf Mitspieler …' : `Turnier mit ${T.players.length} Spielern starten`;
    $('#tl-wait').classList.toggle('hidden', host || T.status !== 'lobby');
    $('#tl-play').classList.toggle('hidden', !(room && room.tourn && game));
    $('#tl-leave').textContent = T.status === 'done' ? 'Zur Startseite' : 'Turnier verlassen';
  }
  $('#tl-bracket').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-walk]');
    if (!b) return;
    if (!confirm(`${b.textContent} – Match kampflos vergeben (z. B. weil ein Spieler weg ist)?`)) return;
    send({ t: 'twalkover', match: b.dataset.walk, winner: b.dataset.w });
  });

  // ---------- Navigation ----------
  function goHome(force) {
    if (!force && game && !game.finished && (mode === 'online' || mode === 'local')) {
      if (!confirm(mode === 'online' ? 'Raum verlassen?' : 'Zur Startseite? (Das Spiel wird gespeichert.)')) return;
    }
    if (tourn) {
      if (!force && tourn.status === 'running' && !confirm('Turnier verlassen? Deine offenen Matches kann der Turnierleiter dann kampflos vergeben.')) return;
      leaveTourn(false);
    }
    if (mode === 'online') leaveOnline();
    if (mode === 'local' && game) LS.set('ds.localGame', game);
    mode = null; game = null; lsess = null;
    detector.phase = 'idle';
    renderHome();
    show('home');
  }
  $('#btn-home').onclick = () => goHome(false);

  function renderHome() {
    hooks.home.forEach((fn) => fn());
    const saved = LS.get('ds.localGame', null);
    let btn = $('#go-resume');
    if (saved && !saved.finished && saved.players) {
      if (!btn) {
        btn = document.createElement('button');
        btn.id = 'go-resume';
        btn.className = 'resume';
        $('#screen-home').prepend(btn);
        btn.onclick = () => { game = LS.get('ds.localGame', null); if (game) startGameView('local'); };
      }
      btn.innerHTML = `<span class="r-label">Weiterspielen</span><span class="r-scores">${saved.players.map((p) => `<span><small>${esc(p.name)}</small><b>${p.score}</b></span>`).join('')}</span>`;
    } else if (btn) btn.remove();
    // Schnellstart
    $$('#quick-mode button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === settings.startScore));
    const me = settings.mePlayer ?? 0, acc = window.Account && window.Account.user;
    $('#quick-players').innerHTML = localNames.map((n, i) => {
      const name = acc && i === me && /^Spieler \d+$/.test(n) ? acc.name.split(' ')[0] : n;
      return `<span class="pchip ${i === me ? 'me' : ''}">${esc(name)}</span>`;
    }).join('') + `<button class="pchip add" id="quick-add" aria-label="Spieler hinzufügen">+</button>`;
    $('#quick-add').onclick = () => $('#go-local').click();
    $('#home-title').textContent = `Neues Spiel${settings.doubleOut === false ? ', Single-Out' : ''}`;
    // Kamera-Status
    const cal = LS.get('ds.cal', null), q = LS.get('ds.calq', null);
    const labels = ['grob', 'ok', 'gut', 'sehr gut'];
    $('#cam-tile-status').innerHTML = cal && cal.pts ? `<i class="sdot ok"></i>Kalibriert${q != null ? ', Genauigkeit ' + labels[q] : ''}` : '<i class="sdot"></i>Noch nicht eingerichtet';
  }
  $('#quick-mode').onclick = (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    settings.startScore = Number(b.dataset.v); saveSettings(); renderHome();
  };
  $('#quick-start').onclick = () => $('#start-local').click();

  $('#go-local').onclick = () => { renderLocalPlayers(); renderGameSettings($('#local-settings'), true); show('local'); };
  $('#go-online').onclick = () => { $('#on-name').value = settings.name || ''; show('online'); };
  $('#go-cam').onclick = async () => { mode = 'test'; testHits = []; renderTestHits(); show('cam'); if (await camOn()) detector.startTurn(); };

  // ---------- Start ----------
  updateTouch();
  renderHome();
  show('home');
  const inviteCode = new URLSearchParams(location.search).get('raum');
  const tInvite = new URLSearchParams(location.search).get('turnier');
  if (tInvite) {
    $('#t-name').value = settings.name || '';
    $('#t-code').value = tInvite.toUpperCase().slice(0, 4);
    renderTOpts();
    show('tourn');
    history.replaceState(null, '', location.pathname);
  } else if (sessionStorage.getItem('ds.tourn')) {
    mode = 'tourn';
    reconnect();
  } else if (inviteCode) {
    $('#on-name').value = settings.name || '';
    $('#on-code').value = inviteCode.toUpperCase().slice(0, 4);
    show('online');
    history.replaceState(null, '', location.pathname);
  } else if (sessionStorage.getItem('ds.online')) {
    mode = 'online';
    room = { code: JSON.parse(sessionStorage.getItem('ds.online')).code, players: [] };
    reconnect();
  }
})();
