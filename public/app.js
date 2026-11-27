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
    { threshold: 28, tipMode: 'auto', autoNext: true, startScore: 501, doubleOut: true, name: '' },
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
  // Die Ansage startet immer AUS und wird mit dem Lautsprecher-Knopf eingeschaltet (der Tipp gibt den Ton im Browser frei).
  function speak(parts, opts) {
    hooks.speak.forEach((fn) => { try { fn(parts); } catch (_) {} }); // auch am gekoppelten Bildschirm ansagen
    if (!window.Speech || !window.Speech.enabled) return;
    window.Speech.say(parts, opts);
  }
  function renderVoiceBtns() {
    const on = !!(window.Speech && window.Speech.enabled);
    $$('[data-voice]').forEach((b) => { b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    $$('[data-voice-label]').forEach((l) => (l.textContent = on ? 'Ansage an' : 'Ansage aus'));
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-voice]');
    if (!b || !window.Speech) return;
    if (window.Speech.enabled) { window.Speech.disable(); toast('Ansage aus'); }
    else window.Speech.enable(); // spricht sofort „Ansage an“ – direkt im Tipp, sonst blockiert der Browser
    renderVoiceBtns();
  });
  const say = (d) => (window.VoiceCmd ? window.VoiceCmd.label(d) : B.speech(d));

  function show(name) {
    screen = name;
    $$('.screen').forEach((s) => s.classList.toggle('hidden', s.id !== 'screen-' + name));
    const slot = name === 'game' ? $('#cam-slot') : name === 'cam' ? $('#cam-slot-test') : name === 'learnplay' ? $('#cam-slot-learn') : name === 'cam2' ? $('#cam-slot-cam2') : null;
    const panel = $('#cam-panel');
    if (slot) { slot.appendChild(panel); panel.classList.remove('hidden'); }
    else panel.classList.add('hidden');
    $('#room-badge').classList.toggle('hidden', !((mode === 'online' && room) || tourn));
    if (tourn) $('#room-badge').textContent = 'T·' + tourn.code;
    else if (room) $('#room-badge').textContent = room.code;
    document.body.classList.toggle('has-badge', !$('#room-badge').classList.contains('hidden'));
    $('#b-tree').classList.toggle('hidden', !(room && room.tourn));
    $('#b-calib').textContent = name === 'cam' ? 'Kalibrieren' : 'Scheibe neu suchen';
    if (name !== 'cam' && calib) stopCalibration();
    // Tab-Leiste: im Spiel ausgeblendet (volle Konzentration), sonst passenden Tab markieren
    const tab = { home: 'home', local: 'home', online: 'home', queue: 'home', lobby: 'home', cam: 'home', learn: 'home', learnplay: 'home', tourn: 'home', tlobby: 'home', devices: 'home', cam2: 'home', stats: 'stats', rank: 'rank', profile: 'profile' }[name];
    document.body.classList.toggle('in-game', name === 'game' || name === 'learnplay');
    $$('#tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    window.scrollTo(0, 0);
    updateZoomRow();
    hooks.show.forEach((fn) => fn(name));
  }

  // Schnittstelle für ui.js (Statistik, Rangliste, Profil)
  const hooks = { update: [], show: [], home: [], learn: [], speak: [] };
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
  // Jeder korrigierte Pfeil wird mit dem ganzen Kamerabild des Wurfs gespeichert (im Browser, übersteht Neuladen).
  // Unter Kamera einrichten → Einstellungen herunterladen und an den Entwickler schicken.
  const RepDB = (() => {
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const r = indexedDB.open('dartscan', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('reports', { keyPath: 'id', autoIncrement: true });
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
    const run = async (mode, fn) => {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction('reports', mode), req = fn(t.objectStore('reports'));
        t.oncomplete = () => res(req && 'result' in req ? req.result : undefined); t.onerror = () => rej(t.error);
      });
    };
    return {
      add: (o) => run('readwrite', (st) => st.add(o)),
      all: () => run('readonly', (st) => st.getAll()),
      count: () => run('readonly', (st) => st.count()),
      clear: () => run('readwrite', (st) => st.clear()),
      del: (id) => run('readwrite', (st) => st.delete(id)),
    };
  })();
  const reportsMem = []; // Ersatz, falls der Browser keine Datenbank erlaubt
  function updateReportCount() {
    RepDB.count().then((n) => { $('#s-report-n').textContent = n; }).catch(() => { $('#s-report-n').textContent = reportsMem.length; });
  }
  function toPng(arr, size) {
    const c = document.createElement('canvas'); c.width = size; c.height = size;
    const x = c.getContext('2d'); const im = x.createImageData(size, size); im.data.set(arr); x.putImageData(im, 0, 0);
    return c.toDataURL('image/png');
  }
  function addReport(old, d) {
    const cap = detector.captures && detector.captures.find((c) => c.id === old.cid);
    const entry = {
      t: new Date().toISOString(), detected: B.label(old), corrected: B.label(d), x: old.x, y: old.y, bdir: old.bdir, bias: detector.tipBias || 0,
      by: cap ? cap.by : null, tip: cap ? cap.tip : null, frame: cap ? cap.frame : null,
      crop: cap ? { before: toPng(cap.before, cap.size), after: toPng(cap.after, cap.size) } : null,
      shot: cap && cap.shot ? cap.shot : null,
      setup: { calib: detector.calib, view: detector.view, hz: detector.hz, w: detector.w, h: detector.h, field: detector.exportField(), version: APP_VERSION + ' ' + BUILD },
    };
    RepDB.add(entry).then(async () => {
      const all = await RepDB.all();
      for (const r of all.slice(0, Math.max(0, all.length - 30))) await RepDB.del(r.id); // die neuesten 30 behalten
      updateReportCount();
    }).catch(() => { reportsMem.push(entry); if (reportsMem.length > 30) reportsMem.shift(); updateReportCount(); });
  }
  const blobUrl = (b) => new Promise((res) => { if (!b) return res(null); const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => res(null); r.readAsDataURL(b); });
  async function downloadReport() {
    let list = [];
    try { list = await RepDB.all(); } catch (_) { list = reportsMem.slice(); }
    if (!list.length) return toast('Noch keine korrigierten Würfe – korrigiere falsch erkannte Pfeile, dann landen sie hier.');
    const entries = [];
    for (const r of list) entries.push({ ...r, shot: await blobUrl(r.shot) });
    const out = { app: 'DartScan', created: new Date().toISOString(), ua: navigator.userAgent, quality: detector.qualityInfo(), entries };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(out)], { type: 'application/json' }));
    a.download = 'dartscan-protokoll-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.json';
    document.body.appendChild(a); a.click(); a.remove();
  }

  const myTurn = () => !!game && (mode === 'local' || game.players[game.current].id === myId);
  const canEdit = () => myTurn() || (mode === 'online' && room && room.hostId === myId);
  window.DS.canEdit = () => canEdit();

  // ---------- Neue Version? Dann neu laden ----------
  // Safari am iPhone behält offene Tabs oft tagelang mit der alten Version. Die Seite fragt deshalb regelmäßig nach.
  const BUILD = (document.querySelector('meta[name="ds-build"]') || {}).content || '';
  const APP_VERSION = (document.querySelector('meta[name="ds-version"]') || {}).content || '';
  window.DS.build = BUILD; window.DS.version = APP_VERSION;
  let updateShown = false;
  async function checkUpdate() {
    if (!BUILD || updateShown) return;
    try {
      const j = await fetch('/version', { cache: 'no-store' }).then((r) => r.json());
      if (!j.v || j.v === BUILD) return;
      const busy = (screen === 'game' && game && !game.finished && mode !== 'test') || screen === 'learnplay' || screen === 'cam2';
      if (!busy) { location.reload(); return; }
      updateShown = true;
      const bar = document.createElement('div');
      bar.className = 'update-bar';
      bar.innerHTML = '<span>Neue DartScan-Version ist da</span><button class="btn cta">Jetzt laden</button>';
      bar.querySelector('button').onclick = () => location.reload();
      document.body.appendChild(bar);
    } catch (_) {}
  }
  setTimeout(checkUpdate, 3000);
  setInterval(checkUpdate, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkUpdate(); });
  // Befehle vom gekoppelten Bildschirm (Laptop): Wurf korrigieren/eintragen, weiter, zurück
  window.DS.displayCmd = (c) => {
    if (!game || screen !== 'game') return;
    const d = c.dart ? { seg: c.dart.seg, mult: c.dart.mult, value: c.dart.seg * c.dart.mult } : null;
    const lbl = d ? B.label(d) : '';
    if (c.kind === 'correct') {
      if (c.which === 'cur') {
        if (!canEdit() || !game.turn.darts[c.index]) return;
        correctDart(c.index, d, false);
      } else {
        if (game.turn.darts.length) return toast('Erst die aktuelle Aufnahme fertig machen');
        correctDart(c.index, d, false);
      }
      toast('Am Bildschirm korrigiert: ' + lbl);
    } else if (c.kind === 'add') {
      if (!myTurn() || game.finished || Game.turnComplete(game)) return;
      act.dart(d); detector.rebaseline(); toast('Am Bildschirm eingetragen: ' + lbl);
    } else if (c.kind === 'remove') {
      if (canEdit() && game.turn.darts[c.index]) act.remove(c.index);
    } else if (c.kind === 'next') { if (canEdit() && !game.finished) act.next(); }
    else if (c.kind === 'undo') { if (canEdit()) act.undo(); }
  };

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
    return `<div class="${cls}" data-i="${i}" ${clickable ? 'role="button" tabindex="0" title="Korrigieren"' : ''}>${B.label(d)}<small>${d.fused ? '2 Kameras' : d.auto ? 'Kamera' : 'von Hand'}</small></div>`;
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
      // Sounds: Einschlag, und am Ende der Aufnahme ggf. 180 / gute Aufnahme / überworfen
      const S = window.Sound;
      if (S) {
        S.hit(d.void ? 0 : d.mult);
        if (t.bust) setTimeout(() => S.bust(), 160);
        else if (cur.n === 3 && !t.won) {
          const total = t.darts.reduce((s2, x) => s2 + x.value, 0);
          if (total === 180) setTimeout(() => S.max(), 180); else if (total >= 100) setTimeout(() => S.good(total), 180);
        }
      }
    } else if (ann && ann.id !== cur.id && cur.n === 0 && !game.finished) {
      window.Sound && window.Sound.turn(); // nächster Spieler
    }
    ann = cur;
  }

  let winShownFor = null;
  function checkWin() {
    const dlg = $('#dlg-win');
    if (!game.finished) { if (dlg.open) dlg.close(); return; }
    if (winShownFor === game.turnId) return;
    winShownFor = game.turnId;
    window.Sound && setTimeout(() => window.Sound.win(), 250);
    const idx = game.players.findIndex((p) => p.id === game.winner);
    const w = game.players[idx];
    const st = Game.stats(game, idx);
    $('#win-text').textContent = `${w.name} gewinnt!`;
    $('#win-sub').textContent = `${st.darts} Pfeile · Ø ${st.avg.toFixed(1)}`;
    const ff = mode === 'online' && room && room.forfeit;
    if (ff) { const lo = game.players.find((p) => p.id === ff.loser); $('#win-sub').textContent = `${lo ? lo.name : 'Gegner'}: ${ff.why}`; }
    const quick = mode === 'online' && room && room.kind === 'quick';
    const host = mode !== 'online' || quick || (room && room.hostId === myId);
    $('#w-rematch').disabled = !host;
    $('#w-rematch').textContent = quick ? 'Revanche anbieten' : host ? 'Revanche' : 'Warte auf Revanche vom Host …';
    if (room && room.tourn) {
      const legs = w.legs + 1, need = room.legsToWin || 1;
      $('#win-sub').textContent += legs >= need ? ' · Match entschieden!' : ` · Leg ${legs}/${need} – nächstes Leg startet gleich …`;
      $('#w-rematch').classList.add('hidden');
      $('#w-home').textContent = 'Zum Turnierbaum';
    } else { $('#w-rematch').classList.remove('hidden'); $('#w-home').textContent = 'Zur Startseite'; }
    $('#w-undo').classList.toggle('hidden', !canEdit() || !!ff);
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
    b.classList.toggle('wait', micOn && !listening && !pausedForSpeech);
    b.setAttribute('aria-pressed', String(micOn));
    $('#b-mic-label').textContent = !micOn ? 'Sprachbefehle' : pausedForSpeech ? 'Ansage …' : listening ? 'Hört zu' : micErr ? micErr : 'Startet …';
  }
  let lastChime = 0, ignoreUntil = 0;
  const caption = (t, cls) => { const c = $('#mic-caption'); c.textContent = t || ''; c.className = 'mic-caption' + (cls ? ' ' + cls : ''); };
  function chime() { if (Date.now() - lastChime > 2500) { lastChime = Date.now(); window.Sound && window.Sound.wake(); } }

  // Spracherkennung, die dauerhaft zuhört:
  //  - Während DartScan selbst spricht (Ansage, Töne), ist das Mikro kurz aus – sonst hört es die eigene Ansage,
  //    vermischt sie mit dem nächsten Befehl, und auf Android bleibt die Erkennung danach oft „hängen“.
  //  - Wächter: hängt eine Sitzung (keine Ereignisse mehr), wird sie neu gestartet; lange Sitzungen werden erneuert.
  //  - Doppelte Ergebnisse (Android liefert manche Sätze zweimal) werden ignoriert.
  let lastEvent = 0, pausedForSpeech = false, lastFinal = { text: '', t: 0 };
  function micStart() {
    micRestartT = null;
    if (!SR) { toast('Sprachbefehle gehen in diesem Browser nicht – am besten Chrome oder Edge verwenden.', 4500); return; }
    micOn = true;
    if (rec) return setMicUI();
    if (selfSpeaking()) { pausedForSpeech = true; setMicUI(); return; } // startet nach der Ansage
    const r = new SR();
    rec = r;
    r.lang = 'de-DE'; r.continuous = true; r.interimResults = true; r.maxAlternatives = 5;
    r.onresult = (e) => {
      if (rec !== r) return;
      lastEvent = Date.now();
      if (selfSpeaking()) return; // eigene Ansage – nicht als Befehl werten
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const alts = Array.from(res, (a) => a.transcript);
        caption('„' + alts[0].trim() + '“', res.isFinal ? '' : 'live');
        if (!res.isFinal) {
          // Aktivierungswort schon während des Sprechens erkennen -> sofort Signalton
          if (alts.some((a) => VC.findWake(VC.normalize(a)) >= 0)) { chime(); wakeUntil = Date.now() + 8000; }
          continue;
        }
        const key = VC.normalize(alts[0]);
        if (key && key === lastFinal.text && Date.now() - lastFinal.t < 2000) continue; // doppelt geliefert
        lastFinal = { text: key, t: Date.now() };
        handleSpeech(alts);
      }
    };
    r.onstart = () => { if (rec !== r) return; listening = true; micErr = ''; recStartedAt = Date.now(); lastEvent = Date.now(); setMicUI(); };
    r.onaudiostart = r.onsoundstart = r.onspeechstart = () => { if (rec !== r) return; listening = true; lastEvent = Date.now(); setMicUI(); };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        micOn = false; settings.mic = false; saveSettings();
        toast('Mikrofon nicht erlaubt – in den Browser-Einstellungen für diese Seite freigeben.', 5000);
      } else if (e.error === 'network') micErr = 'Kein Netz';
      else if (e.error === 'audio-capture') { micErr = 'Kein Mikrofon'; }
      // 'no-speech' und 'aborted' sind normal (Stille / von uns beendet) -> einfach neu starten
    };
    // Die Erkennung beendet sich nach Stille von selbst -> neu starten, solange eingeschaltet.
    // Bricht sie sofort wieder ab (Netz weg, Mikro belegt), mit wachsender Pause neu versuchen statt Dauerschleife.
    r.onend = () => {
      if (rec !== r) return; // alte Sitzung (schon ersetzt)
      const ran = recStartedAt ? Date.now() - recStartedAt : 0;
      rec = null; listening = false; recStartedAt = 0;
      micFails = ran > 1500 || pausedForSpeech ? 0 : micFails + 1;
      const wait = micFails ? Math.min(5000, 250 * 2 ** micFails) : 80;
      clearTimeout(micRestartT); micRestartT = null;
      if (micOn && !pausedForSpeech) micRestartT = setTimeout(micStart, wait);
      if (micFails === 4) toast('Spracherkennung startet nicht richtig – Internet und Mikrofon prüfen', 4000);
      setMicUI();
    };
    try { r.start(); } catch (_) { rec = null; clearTimeout(micRestartT); micRestartT = setTimeout(micStart, 1000); }
    setMicUI();
  }
  // harte Beendigung einer Sitzung (onend kommt manchmal nicht -> nicht darauf warten)
  function micKill() {
    const r = rec;
    rec = null; listening = false; recStartedAt = 0;
    if (r) { try { r.abort(); } catch (_) {} }
  }
  const selfSpeaking = () => !!(window.Speech && window.Speech.talking);
  // Ansage läuft -> Mikro pausieren; danach sofort wieder zuhören
  setInterval(() => {
    if (!micOn) return;
    const speaking = selfSpeaking();
    if (speaking && rec && !pausedForSpeech) { pausedForSpeech = true; micKill(); setMicUI(); return; }
    if (!speaking && pausedForSpeech) { pausedForSpeech = false; clearTimeout(micRestartT); micRestartT = null; micStart(); return; }
    // Wächter: läuft nicht, obwohl an (z. B. nach Bildschirm aus) -> starten
    if (!rec && !micRestartT && !pausedForSpeech) { micStart(); return; }
    // hängt (seit 20 s kein einziges Ereignis) oder läuft sehr lange -> erneuern
    if (rec && recStartedAt && (Date.now() - lastEvent > 20000 || Date.now() - recStartedAt > 90000)) { micKill(); micStart(); }
  }, 250);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !micOn) return;
    micKill(); clearTimeout(micRestartT); micRestartT = setTimeout(micStart, 300);
  });
  function micStop() {
    micOn = false; clearTimeout(micRestartT); micRestartT = null; listening = false; micErr = ''; pausedForSpeech = false;
    micKill();
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
    $('#s-autonext').checked = settings.autoNext;
    $('#s-track').checked = settings.autoTrack !== false;
    $('#s-automiss').checked = settings.autoMiss === true;
    $('#s-lock').checked = settings.lockCam !== false;
    $('#s-sfx').checked = !!(window.Sound && window.Sound.on);
    $('#s-version').textContent = 'DartScan ' + (APP_VERSION || '?') + (BUILD ? ' · ' + BUILD : '');
    $('#s-autozoom').checked = settings.autoZoom !== false;
    renderVoices();
    $('#s-direct').checked = settings.voiceDirect !== false;
    updateReportCount();
    $('#dlg-settings').showModal();
  };
  $('#s-thr').oninput = (e) => { settings.threshold = Number(e.target.value); $('#s-thr-v').textContent = settings.threshold; detector.threshold = settings.threshold; saveSettings(); };
  $('#s-tip').onchange = (e) => { settings.tipMode = e.target.value; detector.tipMode = settings.tipMode; saveSettings(); };
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
  window.DS.renderVoiceBtns = () => renderVoiceBtns();
  $('#s-rate').oninput = (e) => { window.Speech.rate = Number(e.target.value); };
  $('#s-voicetest').onclick = () => window.Speech.test();
  $('#s-direct').onchange = (e) => { settings.voiceDirect = e.target.checked; saveSettings(); };
  $('#s-autonext').onchange = (e) => { settings.autoNext = e.target.checked; saveSettings(); };
  $('#s-sfx').onchange = (e) => { if (window.Sound) { window.Sound.on = e.target.checked; if (e.target.checked) window.Sound.hit(3); } };
  $('#s-autozoom').onchange = (e) => {
    settings.autoZoom = e.target.checked; saveSettings();
    if (settings.autoZoom) maybeAutoZoom(true); else applyZoom({ z: 1, cx: 0.5, cy: 0.5 });
  };
  $('#s-track').onchange = (e) => { settings.autoTrack = e.target.checked; detector.autoTrack = settings.autoTrack; saveSettings(); };
  $('#s-automiss').onchange = (e) => { settings.autoMiss = e.target.checked; detector.autoMiss = settings.autoMiss; saveSettings(); };
  $('#s-lock').onchange = async (e) => {
    settings.lockCam = e.target.checked; saveSettings();
    const ok = await lockCamera(settings.lockCam);
    if (settings.lockCam) toast(ok ? 'Belichtung & Fokus fixiert ✓' : 'Dieses Handy erlaubt das Fixieren im Browser nicht');
  };

  // ---------- Erkennung ----------
  let lastTip = null, lostSince = 0;
  const detector = new D.DartDetector({
    onDart(d, info) {
      if (mode === 'cam2') { window.DS.cam2Dart && window.DS.cam2Dart(d, info); lastTip = { u: info.u, v: info.v, t: Date.now(), label: B.label(d) }; return; }
      // mit 2. Kamera: kurz auf deren Treffer warten und beide verrechnen
      if (window.DS.fuse && window.DS.fuse.active()) { window.DS.fuse.main(d, info); return; }
      acceptDart(d, info);
    },
    onCleared() {
      if (mode === 'cam2') return;
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
      lostSince = 0;
      saveCalib();
      if (r.moved > 2) toast('Kamera verrutscht – Raster automatisch nachgeführt ✓');
    },
    onLost() { lostSince = Date.now(); toast('Scheibe nicht mehr gefunden – ich suche sie automatisch …', 4000); },
    onShift() { saveCalib(); }, // kleine Erschütterung ausgeglichen
    onField(f) { LS.set('ds.field', f); }, // gelernte Pfeilrichtung (Spitze -> Flight) bei diesem Aufbau
    onBias(b) {
      saveCalib();
      toast(`Aus deinen Korrekturen gelernt: Pfeilspitze wird jetzt ${Math.abs(b).toFixed(1).replace('.', ',')} mm weiter ${b > 0 ? 'vorne' : 'hinten'} gesucht`, 5000);
    },
  });
  // Erkannter (ggf. mit der 2. Kamera verrechneter) Pfeil wird gezählt
  function acceptDart(d, info) {
    if (!info && Number.isFinite(d.x)) { const p = detector.toImage(d.x, d.y); if (p) info = { u: p[0], v: p[1] }; }
    if (info) lastTip = { u: info.u, v: info.v, t: Date.now(), label: B.label(d) + (d.fused ? ' ²' : '') };
    if (mode === 'test') { testHits.push(d); renderTestHits(); speak(say(d)); return; }
    if (mode === 'learn') { learnDart(d); return; }
    if (!game || game.finished || !myTurn() || Game.turnComplete(game)) return;
    act.dart(d);
    window.DS.frameDart && window.DS.frameDart(B.label(d));
  }
  window.DS.acceptDart = acceptDart;
  window.DS.turnKey = () => lastTurnKey;
  detector.threshold = settings.threshold;
  detector.tipMode = settings.tipMode;
  detector.autoTrack = settings.autoTrack !== false;
  detector.autoMiss = settings.autoMiss === true;
  window.DartScanDebug = { detector }; // für die Fehlersuche in der Browser-Konsole
  function saveCalib() {
    if (detector.calib) LS.set('ds.cal', { pts: detector.calib, view: detector.view, hz: detector.hz, bias: detector.tipBias || 0, user: !!detector.userOriented });
  }
  (() => {
    const c = LS.get('ds.cal', null);
    if (c && c.pts && c.pts.length === 4) {
      detector.view = c.view || detector.view;
      detector.hz = c.hz || 1;
      detector.tipBias = c.bias || 0;
      detector.userOriented = !!c.user; // 20 wurde vom Nutzer selbst angetippt
      detector.setCalibration(c.pts);
      return;
    }
    const old = LS.get('ds.calib', null); // ältere Version
    if (old && old.length === 4) detector.setCalibration(old);
  })();
  detector.importField(LS.get('ds.field', null));

  function syncDetector() {
    if (mode === 'cam2') return; // die 2. Kamera steuert das Haupt-Handy
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
  let stream = null, debug = false, wakeLock = null;

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
    updateZoomRow();
    enableMotion();
    await applyZoom(zoom, false, true);
    detector.start(video);
    requestWakeLock();
    layoutKey = '';
    invalidate();
    // Belichtung/Weißabgleich/Fokus nach kurzer Eingewöhnung fixieren: verhindert Helligkeitssprünge zwischen den Würfen
    if (settings.lockCam !== false) setTimeout(() => { if (stream) lockCamera(true); }, 2500);
    startVerify(); // gespeicherte Kalibrierung nicht blind übernehmen: Scheibe frisch suchen und vergleichen
    if (!detector.H) {
      lastStatusText = 'Suche die Scheibe …';
      if (mode === 'test') setTimeout(startCalibration, 300); // Kamera einrichten: mit Anzeige
      // in Spiel und Lernen sucht autoSearch() im Hintergrund und übernimmt die Scheibe direkt
    }
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
    $('#cam-off').classList.remove('hidden');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
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
  $('#b-debug').onclick = () => { debug = !debug; $('#b-debug').classList.toggle('on', debug); invalidate(); };
  // Zoom-Regler gibt es nur beim Kamera-Einrichten – im Spiel stellt sich der Zoom von selbst ein
  // Im Spiel/Lernen gibt es unter der Kamera nur „Kamera neu starten“ – alles andere nur unter „Kamera einrichten“
  function updateZoomRow() {
    const setup = mode === 'test';
    $('#zoom-row').classList.toggle('hidden', !(stream && setup));
    for (const id of ['#b-calib', '#b-debug', '#b-settings', '#b-cam-off']) $(id).classList.toggle('hidden', !setup);
    $('#b-restart').classList.toggle('hidden', setup);
    if (!setup && debug) { debug = false; $('#b-debug').classList.remove('on'); }
  }
  // Kamera neu starten: Kamera aus/an, ganzes Bild, Scheibe frisch suchen (nur eine selbst angetippte 20 bleibt gemerkt)
  $('#b-restart').onclick = async () => {
    const b = $('#b-restart');
    b.disabled = true;
    try {
      if (stream) camOff();
      Object.assign(zoom, { z: 1, cx: 0.5, cy: 0.5 }); LS.set('ds.zoom', zoom);
      lostSince = 0;
      if (!(await camOn())) return;
      searchNow = true; searchFresh = !detector.userOriented;
      toast('Kamera neu gestartet – suche die Scheibe …');
    } finally { b.disabled = false; }
  };
  window.DS.updateZoomRow = updateZoomRow;
  // In Spiel/Lernen gibt es kein Kalibrieren von Hand: der Knopf sucht die Scheibe einfach automatisch neu.
  $('#b-calib').onclick = async () => {
    if (!(await camOn())) return;
    if (mode === 'test') return startCalibration();
    searchNow = true; searchFresh = true; detector.userOriented = false;
    setCamStatus('Suche die Scheibe …');
    toast('Suche die Scheibe …');
  };

  // ---------- Zoom ----------
  // Zustand bezogen aufs Kamerabild OHNE Hardware-Zoom: z = Gesamtzoom, cx/cy = Mitte des Ausschnitts (0..1)
  const zoom = Object.assign({ z: 1, cx: 0.5, cy: 0.5 }, LS.get('ds.zoom', {}));
  let hwCaps = null, hwActual = 1, zoomChain = Promise.resolve();
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
  // auto = true: automatischer Zoom – nur digital (Ausschnitt), die Optik wird nie hochgeschaltet.
  // Umschalten der Optik lässt das Bild kurz hängen und verstellt Schärfe/Belichtung.
  function applyZoom(st, save = true, auto = false) {
    Object.assign(zoom, clampZoom(st));
    if (save) LS.set('ds.zoom', zoom);
    updateZoomUI();
    updateTouch();
    zoomChain = zoomChain.then(async () => {
      if (!stream) return;
      let hz = hwFor(zoom);
      if (auto) hz = Math.min(hz, hwActual);
      if (hwCaps && Math.abs(hz - hwActual) > 0.01) {
        try { await track().applyConstraints({ advanced: [{ zoom: hz }] }); hwActual = hz; await sleep(450); }
        catch (_) { hz = hwActual; }
      } else hz = hwCaps ? hwActual : 1;
      detector.setView(viewFor(zoom, hz), hz);
      saveCalib();
      invalidate();
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
  $('#z-range').oninput = (e) => { $('#z-val').textContent = Number(e.target.value).toFixed(1).replace('.', ',') + '×'; };
  $('#z-range').onchange = (e) => applyZoom({ ...zoom, z: Number(e.target.value) });
  $('#z-in').onclick = () => applyZoom({ ...zoom, z: zoom.z * 1.25 });
  $('#z-out').onclick = () => applyZoom({ ...zoom, z: zoom.z / 1.25 });
  $('#z-fit').onclick = zoomToBoard;
  $('#z-reset').onclick = () => applyZoom({ z: 1, cx: 0.5, cy: 0.5 });

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

  // Raster als fertiger Pfad (wird nur neu berechnet, wenn sich Kalibrierung oder Größe ändern)
  let gridCache = { key: null, path: null, nums: null };
  function drawGrid(Hinv, W, H, alpha, dpr) {
    if (!Hinv) return;
    const key = Hinv.join() + ':' + W + ':' + H;
    if (gridCache.key !== key) {
      const P = (x, y) => { const [u, v] = D.applyH(Hinv, x, y); return [u * W, v * H]; };
      const path = new Path2D();
      for (const r of [B.R.bullIn, B.R.bullOut, B.R.trebleIn, B.R.trebleOut, B.R.doubleIn, B.R.doubleOut]) {
        for (let a = 0; a <= 360; a += 4) { const [x, y] = P(...B.polar(r, a)); a === 0 ? path.moveTo(x, y) : path.lineTo(x, y); }
      }
      for (let i = 0; i < 20; i++) {
        const [x1, y1] = P(...B.polar(B.R.bullOut, i * 18 - 9)), [x2, y2] = P(...B.polar(B.R.doubleOut, i * 18 - 9));
        path.moveTo(x1, y1); path.lineTo(x2, y2);
      }
      gridCache = { key, path, nums: B.ORDER.map((n, i) => [n, ...P(...B.polar(190, i * 18))]) };
    }
    ctx.save();
    ctx.strokeStyle = `rgba(242,193,78,${alpha})`;
    ctx.lineWidth = 1.4 * dpr;
    ctx.stroke(gridCache.path);
    ctx.fillStyle = `rgba(242,193,78,${Math.min(1, alpha + 0.3)})`;
    ctx.font = `700 ${13 * dpr}px system-ui`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const [n, x, y] of gridCache.nums) ctx.fillText(n, x, y);
    ctx.restore();
  }

  // ---------- Kamerabild anzeigen ----------
  // Das Video zeigt der Browser selbst an (Grafikkarte, kein Umkopieren), der Zoom-Ausschnitt ist nur CSS.
  // Darüber liegt eine durchsichtige Ebene für Raster und Treffer – sie wird nur neu gezeichnet, wenn sich etwas ändert.
  const camWrap = canvas.parentElement;
  camWrap.insertBefore(video, canvas);
  let layoutKey = '', drawPending = false, lastHinv = null, tipShown = 0;
  function layoutVideo() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return null;
    const v = detector.view;
    const cw = camWrap.clientWidth || 320;
    const ch = (cw * (v.h * vh)) / (v.w * vw);
    const key = [cw, vw, vh, v.x, v.y, v.w, v.h].join();
    if (key !== layoutKey) {
      layoutKey = key;
      canvas.style.height = ch + 'px';
      const sw = cw / v.w, sh = (sw * vh) / vw;
      video.style.width = sw + 'px'; video.style.height = sh + 'px';
      video.style.transform = `translate(${-v.x * sw}px, ${-v.y * sh}px)`;
    }
    return { cw, ch };
  }
  function invalidate() { if (!drawPending) { drawPending = true; requestAnimationFrame(draw); } }
  function draw() {
    drawPending = false;
    if (!stream) return;
    const L = layoutVideo();
    if (!L) { setTimeout(invalidate, 100); return; }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(L.cw * dpr), H = Math.round(L.ch * dpr);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    else ctx.clearRect(0, 0, W, H);
    lastHinv = detector.Hinv;
    if (debug && !calib) drawMask(W, H);
    if (calib) drawCalib(W, H, dpr);
    else drawGrid(detector.Hinv, W, H, debug ? 0.7 : 0.28, dpr);
    tipShown = lastTip && Date.now() - lastTip.t < 3500 && !calib ? lastTip.t : 0;
    if (tipShown) {
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
    if (calib || debug) invalidate(); // nur beim Einrichten/Debug laufend (Lupe, Maske)
  }
  // Günstige Prüfung, ob neu gezeichnet werden muss (Raster nachgeführt, Treffer-Markierung abgelaufen, Größe)
  setInterval(() => {
    if (!stream || drawPending) return;
    const tipWant = lastTip && Date.now() - lastTip.t < 3500 ? lastTip.t : 0;
    if (detector.Hinv !== lastHinv || tipWant !== tipShown) invalidate();
    else { const v = detector.view; if ([camWrap.clientWidth || 320, video.videoWidth, video.videoHeight, v.x, v.y, v.w, v.h].join() !== layoutKey) invalidate(); }
  }, 150);
  window.addEventListener('resize', () => invalidate());

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

  // Kamera einrichten: Die Scheibe wird ohne Knopfdruck laufend gesucht und sofort übernommen.
  // Steht die 20 nicht oben, tippt man auf die echte 20. Von Hand (4 Punkte) geht es nur hier.
  function startCalibration() {
    calib = { pts: [], drag: -1, mode: 'search', quality: null, since: Date.now() };
    updateTouch();
    $('#cam-tools').classList.add('hidden');
    $('#calib-tools').classList.remove('hidden');
    updateCalibHint();
  }
  function startManual() {
    calib = calib || { drag: -1 };
    calib.pts = []; calib.mode = 'manual'; calib.quality = null; calib.snapped = false;
    updateCalibHint();
  }
  // Wischen über das Kamerabild scrollt die Seite – außer beim Kalibrieren und wenn gezoomt (dann verschiebt es den Ausschnitt)
  function updateTouch() { canvas.classList.toggle('capture', !!calib); invalidate(); }
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
    const slow = calib.mode === 'search' && Date.now() - (calib.since || 0) > 9000;
    if (calib.mode === 'search') h.innerHTML = slow
      ? 'Suche die Scheibe … Tipp: Licht an, ganze Scheibe ins Bild. Klappt es gar nicht, tippe auf <b>Manuell</b>.'
      : 'Suche die Scheibe …';
    else if (calib.mode === 'review') h.innerHTML = `Scheibe erkannt ✓ (${pct(calib.quality)} %). Steht die <b>20</b> nicht oben, <b>tippe auf die echte 20</b>.`;
    else if (calib.pts.length < 4) h.innerHTML = PROMPTS[calib.pts.length];
    else h.innerHTML = 'Das gelbe Raster muss auf den Drähten liegen. Punkte bei Bedarf ziehen, dann <b>Fertig</b>.';
    $('#c-done').disabled = calib.mode === 'search' ? !detector.H : calib.pts.length < 4;
    $('#c-auto').classList.toggle('hidden', calib.mode === 'search');
  }
  // Kalibrierung übernehmen (automatisch gefunden, gedreht oder von Hand gesetzt)
  function applyCalib(pts, quiet, userOriented) {
    if (!D.solveH(pts, D.CAL_DST)) { if (!quiet) toast('Punkte ungültig – bitte neu setzen'); return false; }
    detector.userOriented = !!userOriented;
    detector.setCalibration(pts);
    detector.tipBias = 0; detector.biasSamples = []; // neue Kameraposition: neu lernen
    const q = detector.refineCalibration(pts);
    detector.quality = q ? q.quality : null;
    detector.lost = false; lostSince = 0;
    saveCalib();
    lastTurnKey = null;
    if (game || mode === 'learn') syncDetector(); else if (mode === 'test') detector.startTurn();
    return true;
  }
  $('#c-auto').onclick = () => { calib.mode = 'search'; calib.pts = []; calib.since = Date.now(); updateCalibHint(); };
  $('#c-manual').onclick = startManual;
  $('#c-cancel').onclick = () => { stopCalibration(); setCamStatus('Bereit'); };
  $('#c-done').onclick = () => {
    if (calib.mode === 'manual' && !applyCalib(calib.pts, false, true)) return;
    stopCalibration();
    if (detector.H) showQuality(true);
  };

  // ---------- Lagesensor: wo ist oben? (damit die 20 sicher oben liegt) ----------
  // Das Rot/Grün-Muster der Scheibe wiederholt sich alle 36°. Der Lagesensor sagt, wo „oben“ ist – auch wenn das
  // Handy schräg steht. Ohne Sensor gilt: oben im Bild.
  const grav = { v: null, t: 0, on: false };
  function onMotion(e) {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null) return;
    const now = Date.now();
    if (now - grav.t < 90) return; // 10× pro Sekunde reicht
    const k = grav.v ? 0.3 : 1;
    grav.v = grav.v ? [grav.v[0] + (a.x - grav.v[0]) * k, grav.v[1] + (a.y - grav.v[1]) * k, grav.v[2] + (a.z - grav.v[2]) * k] : [a.x, a.y, a.z];
    grav.t = now;
  }
  function enableMotion() {
    if (grav.on || !window.DeviceMotionEvent) return;
    grav.on = true;
    window.addEventListener('devicemotion', onMotion);
    // iPhone (und manche neuere Browser): Sensor nur nach Erlaubnis – die Abfrage muss in einem Tipp passieren
    try {
      if (typeof DeviceMotionEvent.requestPermission === 'function') DeviceMotionEvent.requestPermission().then((st) => { if (st !== 'granted') grav.on = false; }).catch(() => { grav.on = false; });
    } catch (_) {}
  }
  window.addEventListener('pointerdown', () => { if (stream && !grav.on) enableMotion(); }, { capture: true, passive: true });
  // Richtung von „oben“ im Kamerabild (Grad, 0 = oben, im Uhrzeigersinn) – aus der Neigung des Handys
  function upAngle() {
    if (!grav.v || Date.now() - grav.t > 4000) return null;
    const [ax, ay, az] = grav.v, n = Math.hypot(ax, ay, az);
    if (n < 6 || n > 14) return null; // Handy wird gerade bewegt
    const deg = (screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle : (window.orientation || 0);
    const t = (deg * Math.PI) / 180;
    const sx = ax * Math.cos(t) - ay * Math.sin(t), sy = ax * Math.sin(t) + ay * Math.cos(t);
    if (Math.hypot(sx, sy) / n < 0.45) return null; // Handy liegt fast flach: Neigung nicht aussagekräftig
    return (Math.atan2(sx, sy) * 180) / Math.PI;
  }
  window.DS.upAngle = upAngle;

  // ---------- Automatische Scheibensuche (ohne Knopf) ----------
  // Läuft, solange die Kamera an ist und (noch) keine Scheibe bekannt ist, die Scheibe verloren ging,
  // im Einrichten-Modus gesucht wird – und einmal bei jedem Kamerastart: Die gespeicherte Kalibrierung vom letzten Mal
  // wird nicht blind übernommen (Handy steht oft etwas anders -> Raster rastet sonst eine Zahl daneben ein).
  let searchNow = false, searchFresh = false, searchBusy = false, verifyOn = false, verifyTries = 0, lostTick = 0, lastOrient = null;
  function startVerify() { verifyOn = true; verifyTries = 0; }
  setInterval(() => {
    if (!stream || searchBusy || !detector.rgba) return;
    const inSetup = calib && calib.mode === 'search';
    if (calib && !inSetup) return; // Einrichten: Nutzer prüft gerade bzw. setzt Punkte von Hand
    const lostFor = detector.H && detector.lost && lostSince ? Date.now() - lostSince : 0;
    // lange verloren und gezoomt: erst wieder das ganze Bild ansehen
    if (lostFor > 9000 && zoom.z > 1.01) { applyZoom({ z: 1, cx: 0.5, cy: 0.5 }, true, true); lostSince = Date.now() - 2600; startVerify(); return; }
    const lostLong = lostFor > 2500;
    if (lostLong && !inSetup && !searchNow && !verifyOn && ++lostTick % 3) return; // verdeckt (z. B. beim Ziehen): seltener suchen
    if (!(inSetup || !detector.H || lostLong || searchNow || verifyOn)) { maybeAutoZoom(false); return; }
    searchBusy = true;
    try {
      const r = detector.autoCalibrate();
      if (!r) {
        if (verifyOn) {
          verifyTries++;
          if (verifyTries >= 3 && zoom.z > 1.01) { applyZoom({ z: 1, cx: 0.5, cy: 0.5 }, true, true); verifyTries = 0; }
          else if (verifyTries >= 6) verifyOn = false; // alte Kalibrierung behalten (wird laufend nachgeführt)
        }
        if (inSetup) updateCalibHint();
        else if (!detector.H) setCamStatus('Suche die Scheibe … (ganze Scheibe ins Bild, Licht an)');
        return;
      }
      const prev = detector.calib;
      // Bisherige Ausrichtung nur nutzen, wenn sie verlässlich ist: vom Nutzer angetippt oder gerade erst verloren
      const usePrev = prev && !searchFresh && (detector.userOriented || lostLong);
      const o = detector.orientPts(r.pts, { upAngle: upAngle(), prev: usePrev ? prev : null });
      lastOrient = { how: o.how, up: upAngle(), t: Date.now() };
      const pts = o.pts;
      const hadCalib = !!detector.H;
      const checkOnly = verifyOn && hadCalib && !lostLong && !searchNow && !inSetup;
      verifyOn = false; searchNow = false; searchFresh = false;
      if (checkOnly) {
        // passt die alte Kalibrierung (gleiche Lage, gleiche 20, gleich gut)? Dann bleibt sie – kein Springen
        const moved = Math.max(...pts.map((p, i) => Math.hypot(p[0] - prev[i][0], p[1] - prev[i][1])));
        if (moved < 0.012 && (detector.quality || 0) >= r.quality - 0.03) { maybeAutoZoom(true); return; }
      }
      if (!applyCalib(pts, true, o.how === 'vorher' && detector.userOriented)) return;
      if (inSetup) {
        calib.pts = detector.calib.slice(); calib.quality = detector.quality || r.quality; calib.mode = 'review';
        updateCalibHint();
        toast('Scheibe erkannt ✓ – steht die 20 oben?');
      } else if (!checkOnly || !hadCalib) toast(hadCalib && lostLong ? 'Scheibe wiedergefunden ✓' : 'Scheibe erkannt ✓ – los geht’s!');
      setTimeout(() => showQuality(false), 300);
      setCamStatus('Bereit');
      if (!inSetup) setTimeout(() => maybeAutoZoom(true), 200);
    } finally { searchBusy = false; }
  }, 600);

  // ---------- Automatischer Zoom auf die Scheibe ----------
  // Die Scheibe (mit Platz für herausragende Pfeile) soll das Bild füllen: genauer und weniger Rechenarbeit.
  // Nie mitten in einer Aufnahme (Pfeile stecken) – nur wenn die Scheibe leer ist.
  let zoomCheckAt = 0;
  function boardBox(R) {
    const v = detector.view, hz = detector.hz;
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (let a = 0; a < 360; a += 15) {
      const [u, w] = D.applyH(detector.Hinv, ...B.polar(R, a));
      const gx = 0.5 + (v.x + u * v.w - 0.5) / hz, gy = 0.5 + (v.y + w * v.h - 0.5) / hz;
      x0 = Math.min(x0, gx); x1 = Math.max(x1, gx); y0 = Math.min(y0, gy); y1 = Math.max(y1, gy);
    }
    return { x0, x1, y0, y1 };
  }
  function maybeAutoZoom(force) {
    if (!stream || !detector.Hinv || detector.lost || calib || settings.autoZoom === false) return;
    if (!force && (Date.now() - zoomCheckAt < 5000 || mode === 'test')) return; // beim Einrichten zoomt man selbst
    if (detector.turnDarts || detector.awaitClear || detector.phase === 'pull') return;
    zoomCheckAt = Date.now();
    const b = boardBox(232);
    const target = clampZoom({ z: 0.96 / Math.max(b.x1 - b.x0, b.y1 - b.y0), cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2 });
    const cur = viewFor(zoom, 1);
    const cut = b.x0 < cur.x - 0.005 || b.y0 < cur.y - 0.005 || b.x1 > cur.x + cur.w + 0.005 || b.y1 > cur.y + cur.h + 0.005;
    const gain = target.z / zoom.z;
    const shift = Math.hypot(target.cx - zoom.cx, target.cy - zoom.cy) * zoom.z;
    if (cut || gain > 1.2 || (force && (Math.abs(gain - 1) > 0.1 || shift > 0.08))) applyZoom(target, true, true);
  }
  window.DS.autoZoom = () => maybeAutoZoom(true);
  // Messwerte für die Diagnose-Ansicht am gekoppelten Laptop (?bildschirm&diagnose)
  window.DS.diag = () => {
    const d = detector, r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
    const vw = video.videoWidth, vh = video.videoHeight;
    let dir20 = null;
    try { if (d.calib && d.w) dir20 = Math.round(window.BoardFinder.dirOf20(d.calib.map(([u, v]) => [u * d.w, v * d.h]))); } catch (_) {}
    return {
      version: (APP_VERSION || '?') + ' ' + BUILD,
      geraet: ((navigator.userAgent.match(/\(([^)]*)\)/) || [])[1] || '').slice(0, 60),
      kamera: stream ? vw + '×' + vh : 'aus',
      status: lastStatusText,
      scheibe: d.H ? (d.lost ? 'verloren' : 'erkannt') : 'gesucht',
      qualitaet: r3(d.quality),
      zwanzig: dir20 == null ? null : dir20 + '° (0 = oben im Bild)',
      ausrichtung: lastOrient ? lastOrient.how + (lastOrient.up != null ? ' (Sensor ' + Math.round(lastOrient.up) + '°)' : '') : '-',
      sensor: upAngle() == null ? (grav.v ? 'flach/bewegt' : 'keine Daten') : Math.round(upAngle()) + '°',
      selbst20: !!d.userOriented,
      zoom: zoom.z.toFixed(2) + '× (Optik ' + (d.hz || 1).toFixed(2) + ')',
      ausschnitt: [r3(d.view.x), r3(d.view.y), r3(d.view.w), r3(d.view.h)],
      verarbeit: d.w + '×' + d.h,
      tickMs: d.tickMs == null ? null : Math.round(d.tickMs * 10) / 10,
      phase: d.phase + (d.awaitClear ? ' (wartet auf Ziehen)' : '') + ' · Pfeile ' + (d.turnDarts || 0),
      ziehen: d.lastClear || '-',
      richtung: d.field && d.field.fit ? 'gelernt aus ' + d.field.fit.n + ' Pfeilen' + (d.field.fit.V ? ' (Fluchtpunkt)' : ' (eine Richtung)') : 'Kameramodell (noch ' + Math.max(0, 3 - ((d.field && d.field.obs.length) || 0)) + ' eindeutige Pfeile bis gelernt)',
      spitze: d.lastBy ? 'letzter Pfeil: Ende bestimmt per ' + d.lastBy : '-',
      mikro: micOn ? (pausedForSpeech ? 'Pause (Ansage)' : listening ? 'hört zu' : 'startet') : 'aus',
      kalib: d.calib ? d.calib.map(([u, v]) => [r3(u), r3(v)]) : null,
    };
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
    if (!calib || calib.mode === 'search') return;
    e.preventDefault();
    const uv = toUV(e);
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
        // auf die echte 20 getippt -> Raster drehen, neu einpassen und gleich übernehmen
        const turned = window.BoardFinder.reorient(calib.pts, uv);
        const ref = detector.refineCalibration(turned);
        calib.pts = ref && ref.quality > 0.1 ? ref.pts : turned;
        applyCalib(calib.pts, true, true);
        toast('Ausrichtung geändert – passt die 20 jetzt?');
        return;
      } else return;
    }
    calib.start = uv;
    calib.orig = calib.pts[calib.drag].slice();
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!calib || calib.drag < 0) return;
    const uv = toUV(e);
    calib.pts[calib.drag] = [calib.orig[0] + uv[0] - calib.start[0], calib.orig[1] + uv[1] - calib.start[1]];
  });
  const endDrag = (e) => {
    if (calib && calib.drag >= 0) {
      const wasNew = calib.mode === 'manual' && calib.drag === 3 && calib.pts.length === 4 && !calib.snapped;
      calib.drag = -1;
      if (wasNew) { calib.snapped = true; snapManual(); }
      if (calib.mode === 'review') applyCalib(calib.pts, true, detector.userOriented);
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

  // ---------- Lernpfad als Karte: von Punkt zu Punkt, jede Stufe endet mit einer Prüfung ----------
  const LOCK_SVG = '<svg viewBox="0 0 24 24" class="lock" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
  const CROWN_SVG = '<svg viewBox="0 0 24 24" class="crown" aria-hidden="true"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/></svg>';
  const TYPE_NAME = { hits: 'Treffer', atc: 'Rund um die Uhr', score: 'Punkte', checkout: 'Checkout', x01: 'Spiel', shanghai: 'Shanghai', bobs27: 'Doppel-Spiel' };
  function renderLearnList() {
    const lvl = Learn.level(lprog), tot = Learn.totalStars(lprog), max = Learn.LESSONS.length * 3;
    const rank = lvl ? Learn.STAGES[lvl - 1].name : 'Neuling';
    const nextL = Learn.nextOpen(lprog);
    let h = `<div class="lv-card">
      <div class="lv-badge">${lvl || '–'}</div>
      <div class="lv-info"><small>Dein Level</small><b>${rank}</b><span>${tot} / ${max} Sterne · ${Learn.LESSONS.filter((l) => lprog[l.id] && lprog[l.id].stars).length}/${Learn.LESSONS.length} Übungen</span></div>
      ${nextL ? `<button class="btn cta" id="lv-go">Weiter</button>` : '<span class="lv-done">Alles gemeistert 🏆</span>'}
    </div>`;
    const ROW = 96;
    let n = 0;
    for (const S of Learn.STAGES) {
      const ls = Learn.LESSONS.filter((l) => l.stage === S.id);
      const got = ls.reduce((a, l) => a + ((lprog[l.id] && lprog[l.id].stars) || 0), 0);
      const pts = ls.map((L, i) => ({ L, x: 50 + 30 * Math.sin((n + i) * 1.05), y: ROW / 2 + i * ROW }));
      n += ls.length;
      const height = ls.length * ROW;
      let path = '', done = '';
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i], my = (a.y + b.y) / 2;
        const seg = `M${a.x} ${a.y} C${a.x} ${my} ${b.x} ${my} ${b.x} ${b.y}`;
        path += seg + ' ';
        if (lprog[b.L.id] && lprog[b.L.id].stars) done += seg + ' ';
      }
      h += `<section class="map-stage" style="--c:${S.color}">
        <div class="map-banner"><span class="map-num">${S.id}</span><span class="map-name"><b>${S.name}</b><small>${S.sub}</small></span><span class="map-stars">${starSvg(true)} ${got}/${ls.length * 3}</span></div>
        <div class="map-track" style="height:${height}px">
          <svg class="map-path" viewBox="0 0 100 ${height}" preserveAspectRatio="none" aria-hidden="true"><path class="todo" d="${path}"/><path class="done" d="${done}"/></svg>
          ${pts.map(({ L, x, y }, i) => {
            const p = lprog[L.id], open = Learn.unlocked(lprog, L.id), cur = nextL && nextL.id === L.id;
            const cls = ['map-node', L.boss ? 'boss' : '', p && p.stars ? 'done' : '', open ? '' : 'locked', cur ? 'cur' : ''].join(' ');
            const inner = !open ? LOCK_SVG : L.boss ? CROWN_SVG : `<b>${i + 1}</b>`;
            return `<button class="${cls}" data-l="${L.id}" style="left:${x}%;top:${y}px" aria-label="${esc(L.title)}">
              <span class="mn-dot">${inner}</span>
              <span class="mn-label">${cur ? '<em>Start</em>' : ''}${esc(L.title)}</span>
              ${p && p.stars ? `<span class="mn-stars">${stars(p.stars)}</span>` : ''}
            </button>`;
          }).join('')}
        </div>
      </section>`;
    }
    $('#learn-body').innerHTML = h;
    const go = $('#lv-go');
    if (go) go.onclick = () => openLessonInfo(nextL.id);
  }
  function scrollToCurrent() {
    const c = $('#learn-body .map-node.cur');
    if (c) c.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  function bestText(L, p) {
    if (!p || p.best == null) return '';
    const v = String(p.best).replace('.', ',');
    if (L.type === 'atc' || L.type === 'x01') return `Bestes Ergebnis: ${v} Pfeile`;
    if (L.type === 'score') return `Bester Schnitt: Ø ${v}`;
    if (L.type === 'checkout') return `Bestes Ergebnis: ${v} Checkouts`;
    if (L.type === 'hits') return `Bestes Ergebnis: ${v} Treffer`;
    return `Bestes Ergebnis: ${v} Punkte`;
  }
  function openLessonInfo(id) {
    const L = Learn.byId[id], S = Learn.STAGES[L.stage - 1], p = lprog[id], open = Learn.unlocked(lprog, id);
    $('#li-stage').textContent = `Stufe ${S.id} · ${S.name}${L.boss ? ' · Prüfung' : ''} · ${TYPE_NAME[L.type] || ''}`;
    $('#li-stage').style.color = S.color;
    $('#li-title').textContent = L.title;
    $('#li-goal').textContent = L.goal;
    $('#li-stars').innerHTML = stars(p ? p.stars : 0);
    $('#li-best').textContent = bestText(L, p) + (p && p.tries ? ` · ${p.tries}× gespielt` : '');
    $('#li-tip').textContent = L.coach[0] || '';
    $('#li-start').classList.toggle('hidden', !open);
    $('#li-start').textContent = p && p.stars ? 'Nochmal spielen' : 'Starten';
    $('#li-locked').classList.toggle('hidden', open);
    $('#li-start').onclick = () => { $('#dlg-lesson').close(); startLesson(id); };
    $('#dlg-lesson').showModal();
  }
  $('#learn-body').addEventListener('click', (e) => { const b = e.target.closest('.map-node[data-l]'); if (b) openLessonInfo(b.dataset.l); });

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
    if (L.type === 'atc') { label = 'Triff'; sub = L.mult === 2 ? 'Nur Doppel zählen' : L.mult === 3 ? 'Nur Triple zählen' : 'Single, Doppel oder Triple'; }
    if (L.type === 'score') { label = 'Ziel'; val = 'T' + (L.seg || 20); sub = `Möglichst viele Punkte auf die ${L.seg || 20}`; }
    if (L.type === 'shanghai') { label = 'Runde ' + Math.min(L.seq.length, lsess.rounds.length + 1); sub = 'Single 1×, Doppel 2×, Triple 3× · S+D+T = Shanghai!'; }
    if (L.type === 'bobs27') { const n = L.seq[Math.min(L.seq.length - 1, lsess.rounds.length)]; label = 'Triff'; sub = st.dead ? 'Unter 0 – vorbei' : `${st.info.score} Punkte · Treffer +${2 * n}, keiner −${2 * n}`; }
    if (L.type === 'checkout' || L.type === 'x01') {
      label = L.type === 'x01' ? L.start + ' – Rest' : 'Checkout';
      const co = st.rest > 0 && !st.curDone ? Game.checkout(st.rest, st.info.dartsLeft, L.doubleOut !== false) : null;
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
    hooks.learn.forEach((fn) => { try { fn(lsess); } catch (e) { console.error(e); } });
    if (st.finished) setTimeout(learnFinished, 700);
  }

  function learnDart(d) {
    if (!lsess || lsess.st.finished || lsess.st.curDone) return;
    const L = Learn.byId[lsess.id];
    const before = lsess.st;
    if (!Learn.addDart(lsess, d)) return;
    const st = lsess.st, parts = [say(d)];
    if (L.type === 'atc' && st.info.pos > before.info.pos) {
      const nx = L.seq[st.info.pos];
      parts.length = 0;
      parts.push(st.info.pos >= L.seq.length ? 'Geschafft!' : nx === 25 ? 'Bull' : (L.mult === 2 ? 'Doppel ' : L.mult === 3 ? 'Triple ' : '') + nx);
    }
    if (L.type === 'shanghai' && st.shanghai) parts.push('Shanghai!');
    if ((L.type === 'shanghai' || L.type === 'bobs27') && lsess.cur.length === 3 && !st.finished) parts.push(L.type === 'bobs27' ? 'Doppel ' + L.seq[lsess.rounds.length + 1] : String(L.seq[lsess.rounds.length + 1]));
    if (L.type === 'checkout' && st.curDone) { const r = st.results[lsess.rounds.length]; parts.push(r.out === 'ok' ? 'Checkout!' : r.out === 'bust' ? 'Überworfen' : ''); }
    if (L.type === 'x01' && st.curBust) parts.push('Überworfen');
    if (L.type === 'x01' && st.rest === 0) parts.push('Game shot!');
    if ((L.type === 'score' || L.type === 'shanghai') && lsess.cur.length === 3) {
      const tg = L.type === 'shanghai' ? L.seq[lsess.rounds.length] : null;
      const t = lsess.cur.filter((x) => tg == null || x.seg === tg).reduce((a, x) => a + x.value, 0);
      parts.splice(1, 0, t === 180 ? 'Hundertachtzig!' : String(t));
    }
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
    saveLearnLocal();
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
    syncLearn();
    speak(st.passed ? (lvlUp ? ['Bestanden!', 'Neue Stufe erreicht'] : 'Bestanden!') : 'Noch nicht geschafft', { force: false });
    $('#dlg-learn').showModal();
  }

  function openLearn() { mode = null; lsess = null; detector.phase = 'idle'; renderLearnList(); show('learn'); setTimeout(scrollToCurrent, 120); }
  $('#go-learn').onclick = () => { if (requireAccount('den Lernpfad', openLearn)) openLearn(); };
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

  // ---------- Konto nötig (Online, Turniere, Lernpfad) ----------
  let afterLogin = null;
  function requireAccount(what, fn) {
    const A = window.Account;
    if (A && A.user) return true;
    if (A && !A.ready) { toast('Anmeldung wird geladen …'); afterLogin = fn || null; return false; }
    afterLogin = fn || null;
    toast(A && A.error ? A.error : `Für ${what} brauchst du ein kostenloses Konto – kurz anmelden, dann geht’s los.`, 4500);
    $('#acct-chip').click();
    return false;
  }
  window.DS.requireAccount = requireAccount;
  window.addEventListener('account', (e) => {
    const u = e.detail;
    if (u) {
      syncLearn();
      if (!settings.name) { settings.name = u.name.split(' ')[0].slice(0, 16); saveSettings(); }
      if (afterLogin) { const f = afterLogin; afterLogin = null; setTimeout(f, 60); }
      if (net.open && !net.authed) ensureAuth();
    } else afterLogin = null;
  });

  // Lernpfad mit dem Konto abgleichen (Fortschritt auf allen Geräten)
  async function syncLearn() {
    const A = window.Account;
    if (!A || !A.user || !A.loadUser) return;
    const key = 'ds.learn.' + A.user.uid;
    let local = Learn.mergeProgress(LS.get(key, {}), lprog);
    const legacy = LS.get('ds.learn', null); // Fortschritt aus der Zeit vor dem Konto
    if (legacy) { local = Learn.mergeProgress(local, legacy); LS.del('ds.learn'); }
    try {
      const doc = await A.loadUser();
      const merged = Learn.mergeProgress(local, (doc && doc.learn) || {});
      lprog = merged;
      LS.set(key, merged);
      if (JSON.stringify(merged) !== JSON.stringify((doc && doc.learn) || {})) await A.saveLearn(merged);
    } catch (_) { lprog = local; LS.set(key, local); }
    if (screen === 'learn') renderLearnList();
    learnTile();
  }
  function saveLearnLocal() {
    const A = window.Account;
    LS.set(A && A.user ? 'ds.learn.' + A.user.uid : 'ds.learn', lprog);
  }

  // ---------- Verbindung zum Server (Online, Turniere, gekoppelte Geräte) ----------
  const netListeners = {};
  const emitNet = (t, m) => (netListeners[t] || []).forEach((fn) => { try { fn(m); } catch (e) { console.error(e); } });
  const net = {
    on(t, fn) { (netListeners[t] || (netListeners[t] = [])).push(fn); },
    send: (m) => send(m, true),
    connect: () => connect(),
    get open() { return !!(ws && ws.readyState === 1); },
    authed: false,
    keep: new Set(), // weitere Gründe, die Verbindung zu halten (gekoppelte Geräte)
  };
  window.DS.net = net;
  let queueing = null; // Zufallsgegner: { startScore }

  function send(m, quiet) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(m));
    else if (!quiet) toast('Keine Verbindung zum Server …');
  }
  const needsConnection = () => !!((mode === 'online' && room) || tourn || queueing || net.keep.size || sessionStorage.getItem('ds.tourn') || sessionStorage.getItem('ds.online'));

  let connecting = null, authWaiter = null;
  function connect() {
    if (ws && ws.readyState === 1) return ensureAuth();
    if (connecting) return connecting;
    connecting = new Promise((resolve, reject) => {
      const sock = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
      ws = sock;
      net.authed = false;
      sock.onopen = async () => {
        clearInterval(pingTimer);
        pingTimer = setInterval(() => send({ t: 'ping' }, true), 25000);
        try { await ensureAuth(); } catch (_) {}
        connecting = null;
        resolve(net.authed);
        emitNet('open');
      };
      sock.onerror = () => { if (connecting) { connecting = null; reject(new Error('Keine Verbindung zum Server')); } };
      sock.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (_) { return; } onServer(m); };
      sock.onclose = () => {
        if (ws !== sock) return;
        ws = null; net.authed = false; connecting = null;
        clearInterval(pingTimer);
        emitNet('close');
        if (needsConnection()) { toast('Verbindung weg – verbinde neu …'); setTimeout(reconnect, 1500); }
      };
    });
    return connecting;
  }
  // Anmeldung beim Server (er prüft das Konto selbst)
  async function ensureAuth() {
    const A = window.Account;
    if (net.authed) return true;
    if (!A || !A.user || !A.getToken) return false;
    let token = null;
    try { token = await A.getToken(); } catch (_) {}
    if (!token || !(ws && ws.readyState === 1)) return false;
    return new Promise((resolve) => {
      const done = (v) => { if (authWaiter === done) authWaiter = null; resolve(v); };
      authWaiter = done;
      send({ t: 'auth', token, name: settings.name || A.user.name }, true);
      setTimeout(() => done(net.authed), 8000);
    });
  }
  // online-fähig? (verbunden + angemeldet)
  async function goOnline() {
    try { await connect(); } catch (e) { toast(e.message); return false; }
    if (!(await ensureAuth())) { toast('Anmeldung beim Server fehlgeschlagen – bitte neu anmelden.', 4500); return false; }
    return true;
  }

  async function reconnect() {
    if (!needsConnection()) return;
    try { await connect(); } catch (_) { setTimeout(reconnect, 3000); return; }
    const tsaved = JSON.parse(sessionStorage.getItem('ds.tourn') || 'null');
    if (tsaved) send({ t: 'trejoin', code: tsaved.code, id: tsaved.id }, true);
    const saved = JSON.parse(sessionStorage.getItem('ds.online') || 'null');
    if (saved && (mode === 'online' || tsaved)) send({ t: 'rejoin', code: saved.code, id: saved.id }, true);
    if (queueing) send({ t: 'quick', startScore: queueing.startScore, name: settings.name }, true);
    emitNet('reconnected');
  }

  // Kamerabild der Gegner (Fair Play)
  const oppFrames = new Map(); // Spieler-ID -> { img, dart, ts }
  let oppShown = null;

  function onServer(m) {
    switch (m.t) {
      case 'authok':
        net.authed = true;
        if (authWaiter) authWaiter(true);
        break;
      case 'autherr':
        net.authed = false;
        if (authWaiter) authWaiter(false);
        toast(m.msg, 5000);
        break;
      case 'needauth':
        requireAccount('Online-Spiele');
        break;
      case 'joined':
        myId = m.id;
        sessionStorage.setItem('ds.online', JSON.stringify({ code: m.code, id: m.id }));
        break;
      case 'queued':
        $('#queue-info').textContent = `${m.startScore} · Double-Out${m.waiting > 1 ? ' · ' + m.waiting + ' warten' : ''}`;
        if (screen !== 'queue') show('queue');
        break;
      case 'unqueued':
        queueing = null;
        break;
      case 'room': {
        const wasGame = !!game && mode === 'online';
        const prevCode = room && room.code;
        mode = 'online';
        room = m.room;
        if (room.code !== prevCode) { oppFrames.clear(); oppShown = null; }
        if (queueing && room.kind === 'quick') { queueing = null; window.Sound && window.Sound.ok(); speak('Gegner gefunden'); }
        const prevTurn = game && game.turnId;
        game = room.game;
        // jedes neue Online-Spiel (auch Revanche / Turnier-Match) kostet einen Coin
        if (game && game.id !== paidGameId && game.players.some((p) => p.id === myId)) { paidGameId = game.id; Coins.spend(1, room.tourn ? 'turnier' : 'online'); }
        if (game) {
          if (!wasGame || screen !== 'game') { lastTurnKey = null; winShownFor = null; resetAnnounce(); show('game'); if (!stream) setTimeout(() => toast('Kamera starten – dein Gegner sieht dann deine Scheibe.', 4000), 600); }
          if (prevTurn && game.turnId < prevTurn) winShownFor = null; // Revanche
          update();
        } else {
          if ($('#dlg-win').open) $('#dlg-win').close();
          show('lobby');
          renderLobby();
        }
        break;
      }
      case 'frame':
        if (m.from === 'me') { emitNet('frame', m); break; } // eigenes Bild (am gekoppelten Bildschirm)
        oppFrames.set(m.from, { img: m.img, dart: m.dart, ts: Date.now() });
        renderOpp();
        break;
      case 'forfeit':
        toast(m.loser === myId ? 'Du hast das Match verloren (' + m.why + ').' : 'Dein Gegner ist raus (' + m.why + ') – du gewinnst!', 5000);
        break;
      case 'rematchvote':
        if (!m.mine) toast('Dein Gegner möchte eine Revanche – tippe auf „Revanche“.', 5000);
        else toast('Revanche angeboten – warte auf den Gegner …');
        break;
      case 'reported':
        toast(m.again ? 'Du hast diesen Spieler schon gemeldet.' : 'Danke! Die Meldung ist eingegangen – wir schauen sie uns an.', 4500);
        break;
      case 'error':
        toast(m.msg);
        break;
      case 'tlist':
        tlistCache = m.list;
        renderTList();
        break;
      case 'tjoined':
        tId = m.id;
        sessionStorage.setItem('ds.tourn', JSON.stringify({ code: m.code, id: m.id }));
        if (mode !== 'online') mode = 'tourn';
        break;
      case 'tourn': {
        const first = !tourn;
        const wasDone = tourn && tourn.status === 'done';
        tourn = m.tourn;
        if (first && mode !== 'online') mode = 'tourn';
        if (screen === 'tlobby' || screen === 'tourn' || (first && screen !== 'game')) { renderTLobby(); if (screen !== 'tlobby') show('tlobby'); }
        if (!wasDone && tourn.status === 'done' && tourn.champion === tId) { speak('Turniersieg!'); toast('🏆 Du hast das Turnier gewonnen!', 6000); }
        tournTile();
        break;
      }
      case 'tmatchdone':
        room = null; game = null; myId = null; mode = 'tourn';
        sessionStorage.removeItem('ds.online');
        if ($('#dlg-win').open) $('#dlg-win').close();
        detector.phase = 'idle';
        speak(m.won ? 'Match gewonnen!' : 'Match verloren');
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
      default:
        emitNet(m.t, m);
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
    send({ t: 'leave' }, true);
    sessionStorage.removeItem('ds.online');
    room = null; myId = null; queueing = null;
    oppFrames.clear(); renderOpp();
    if (mode === 'online') { mode = null; game = null; }
  }

  function getName() {
    const n = $('#on-name').value.trim();
    if (!n) { toast('Bitte zuerst deinen Spielernamen eingeben'); $('#on-name').focus(); return null; }
    settings.name = n; saveSettings();
    return n;
  }
  let qScore = 501;
  $('#q-score').onclick = (e) => { const b = e.target.closest('button[data-v]'); if (!b) return; qScore = Number(b.dataset.v); $$('#q-score button').forEach((x) => x.classList.toggle('on', x === b)); };
  $('#on-quick').onclick = async () => {
    const name = getName(); if (!name) return;
    if (!requireAccount('Online-Spiele', () => $('#go-online').click())) return;
    if (!(await goOnline())) return;
    queueing = { startScore: qScore };
    $('#queue-info').textContent = `${qScore} · Double-Out`;
    show('queue');
    send({ t: 'quick', startScore: qScore, name });
  };
  $('#queue-cancel').onclick = () => { send({ t: 'quickcancel' }, true); queueing = null; show('online'); };
  $('#on-tourns').onclick = () => $('#go-tourn').click();
  $('#on-create').onclick = async () => {
    const name = getName(); if (!name) return;
    if (!requireAccount('Online-Spiele', () => $('#go-online').click())) return;
    if (!(await goOnline())) return;
    mode = 'online'; send({ t: 'create', name });
  };
  $('#on-join').onclick = async () => {
    const name = getName(); if (!name) return;
    const code = $('#on-code').value.trim().toUpperCase();
    if (code.length !== 4) return toast('Der Code hat 4 Zeichen');
    if (!requireAccount('Online-Spiele', () => { $('#go-online').click(); $('#on-code').value = code; })) return;
    if (!(await goOnline())) return;
    mode = 'online'; send({ t: 'join', code, name });
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

  // ---------- Live-Bild des Gegners + Melden ----------
  function oppTarget() {
    if (mode !== 'online' || !room || !game) return null;
    const others = game.players.filter((p) => p.id !== myId);
    if (!others.length) return null;
    const cur = game.players[game.current];
    if (cur && cur.id !== myId) return cur;
    // ich bin dran: wer zuletzt geworfen hat (bzw. der einzige Gegner)
    let best = others[0], bt = -1;
    for (const p of others) { const f = oppFrames.get(p.id); if (f && f.ts > bt) { bt = f.ts; best = p; } }
    return best;
  }
  function renderOpp() {
    const box = $('#opp-cam');
    const p = oppTarget();
    if (!p) { box.classList.add('hidden'); oppShown = null; return; }
    box.classList.remove('hidden');
    oppShown = p.id;
    const f = oppFrames.get(p.id);
    const rp = room.players.find((x) => x.id === p.id);
    const fresh = f && Date.now() - f.ts < 8000;
    $('#opp-title').textContent = `Live-Bild: ${p.name}` + (fresh ? '' : rp && rp.online === false ? ' (offline)' : '');
    if (f) $('#opp-img').src = f.img;
    $('#opp-img').classList.toggle('stale', !fresh);
    $('#opp-none').classList.toggle('hidden', !!f);
    $('#opp-none').textContent = rp && rp.cam ? 'Bild kommt gleich …' : `${p.name} hat die Kamera nicht an`;
    $('#opp-dart').textContent = f && f.dart && fresh ? f.dart : '';
    box.classList.toggle('nocam', !(rp && rp.cam));
  }
  setInterval(() => { if (screen === 'game' && mode === 'online') renderOpp(); }, 2000);
  $('#b-report').onclick = () => {
    const p = oppShown && game && game.players.find((x) => x.id === oppShown);
    if (!p) return;
    $('#rp-who').textContent = `Du meldest ${p.name}. Die letzten Kamerabilder und der Spielverlauf werden mitgeschickt.`;
    $('#rp-text').value = '';
    $('#rp-send').onclick = () => {
      const reason = (document.querySelector('#rp-reasons input:checked') || {}).value || 'Sonstiges';
      send({ t: 'report', target: p.id, reason, text: $('#rp-text').value.trim() });
      $('#dlg-report').close();
    };
    $('#dlg-report').showModal();
  };

  // Eigenes Kamerabild senden: an Gegner (online, eigener Zug) und an gekoppelte Bildschirme
  const shot = document.createElement('canvas');
  let myTurnEnd = 0, pendingDart = null, lastShot = 0;
  function wantFrames() {
    if (!stream || !canvas.width) return false;
    if ((window.DS.linkCount || 0) > 0) return true;
    if (mode !== 'online' || !room || !game) return false;
    if (myTurn() && !game.finished) { myTurnEnd = Date.now(); return true; }
    return Date.now() - myTurnEnd < 4000; // kurz nach der Aufnahme: Pfeile stecken noch, Gegner kann prüfen
  }
  function sendFrame() {
    if (!wantFrames()) return;
    const w = 400, h = Math.round((w * canvas.height) / canvas.width);
    if (shot.width !== w || shot.height !== h) { shot.width = w; shot.height = h; }
    // Kamerabild (gleicher Ausschnitt wie am Handy) + Raster/Treffer-Ebene darüber
    const sc = shot.getContext('2d'), v = detector.view, vw = video.videoWidth, vh = video.videoHeight;
    if (vw) sc.drawImage(video, v.x * vw, v.y * vh, v.w * vw, v.h * vh, 0, 0, w, h);
    sc.drawImage(canvas, 0, 0, w, h);
    let img;
    try { img = shot.toDataURL('image/jpeg', 0.6); } catch (_) { return; }
    send({ t: 'frame', img, dart: pendingDart }, true);
    pendingDart = null;
    lastShot = Date.now();
  }
  setInterval(() => { if (ws && ws.readyState === 1 && Date.now() - lastShot > 480) sendFrame(); }, 250);
  window.DS.frameDart = (label) => { pendingDart = label; setTimeout(sendFrame, 300); };

  // ---------- Turniere gegen Fremde ----------
  let tlistCache = null, tlistTimer = null;
  const fmtText = (f) => `${f.startScore} · ${f.doubleOut ? 'Double-Out' : 'Single-Out'} · ${f.legs === 1 ? '1 Leg' : 'Best of ' + (f.legs * 2 - 1)}`;
  const mmss = (ms) => { const t = Math.max(0, Math.round(ms / 1000)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
  function renderTList() {
    const el = $('#t-list');
    if (!tlistCache) { el.innerHTML = '<p class="muted">Lade Turniere …</p>'; return; }
    el.innerHTML = tlistCache.map((f) => {
      const mine = tourn && tourn.fmt === f.fmt && tourn.status !== 'done';
      const st = f.startsAt ? `Start in ${mmss(f.startsAt - Date.now())}` : f.waiting ? `${f.waiting}/${f.size} warten` : 'Sei der Erste!';
      return `<div class="t-card">
        <div class="t-card-head"><b>${esc(f.title)}</b><span class="t-size">${f.size} Spieler</span></div>
        <div class="t-fmt">${fmtText(f)}</div>
        <div class="t-meter"><i style="width:${Math.round((f.waiting / f.size) * 100)}%"></i></div>
        <div class="t-foot"><span>${st}${f.running ? ` · ${f.running} läuft gerade` : ''}</span>
          <button class="btn ${mine ? '' : 'cta'}" data-fmt="${f.fmt}">${mine ? 'Zum Turnier' : 'Mitmachen'}</button></div>
      </div>`;
    }).join('');
  }
  $('#t-list').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-fmt]');
    if (!b) return;
    if (tourn && tourn.fmt === b.dataset.fmt && tourn.status !== 'done') { renderTLobby(); show('tlobby'); return; }
    if (tourn && tourn.status !== 'done') return toast('Du bist schon in einem Turnier.');
    if (!requireAccount('Turniere', () => $('#go-tourn').click())) return;
    if (!(await goOnline())) return;
    if (tourn && tourn.status === 'done') leaveTourn(false);
    send({ t: 'tjoin', fmt: b.dataset.fmt, name: settings.name || (window.Account.user && window.Account.user.name) });
  });
  $('#go-tourn').onclick = async () => {
    if (!requireAccount('Turniere', () => $('#go-tourn').click())) return;
    if (tourn && tourn.status !== 'done') { renderTLobby(); show('tlobby'); return; }
    renderTList(); show('tourn');
    if (!(await goOnline())) return;
    send({ t: 'tlist' });
  };
  setInterval(() => {
    if (screen === 'tourn' && ws && ws.readyState === 1) send({ t: 'tlist' }, true);
    if (screen === 'tlobby' && tourn && (tourn.status === 'starting' || tourn.status === 'lobby')) renderTLobby();
  }, 3000);
  setInterval(() => { if (screen === 'tlobby' && tourn && tourn.status === 'starting') renderTLobby(); if (screen === 'tourn' && tlistCache && tlistCache.some((f) => f.startsAt)) renderTList(); }, 1000);
  function tournTile() {
    $('#tourn-tile-status').textContent = tourn && tourn.status !== 'done' ? `Du bist dabei: ${tourn.title}` : 'Gegen Spieler aus aller Welt';
  }
  hooks.home.push(tournTile);
  $('#tl-leave').onclick = () => {
    if (tourn && tourn.status === 'running' && !tourn.players.find((p) => p.id === tId).out && !confirm('Turnier wirklich verlassen? Dein laufendes oder nächstes Match zählt dann als verloren.')) return;
    leaveTourn(false); goHome(true);
  };
  $('#tl-play').onclick = () => { if (room && game) show('game'); };
  $('#b-tree').onclick = () => { renderTLobby(); show('tlobby'); };

  function leaveTourn(silent) {
    if (!silent) send({ t: 'tleave' }, true);
    sessionStorage.removeItem('ds.tourn');
    tourn = null; tId = null;
    if (mode === 'tourn') mode = null;
    tournTile();
  }

  const roundName = (r, n) => (r === n - 1 ? 'Finale' : r === n - 2 ? 'Halbfinale' : r === n - 3 ? 'Viertelfinale' : 'Runde ' + (r + 1));
  function renderTLobby() {
    if (!tourn) return;
    const T = tourn;
    const nm = (id) => { const p = T.players.find((x) => x.id === id); return p ? p.name : ''; };
    $('#tl-title').textContent = T.status === 'done' ? 'Turnier beendet' : T.title;
    $('#tl-mode').textContent = fmtText({ ...T.opts, legs: T.opts.legs });
    let st = '';
    if (T.status === 'lobby') {
      const minP = { 4: 3, 8: 4, 16: 6 }[T.size] || 2;
      st = `<div class="tl-info"><b>${T.players.length}/${T.size}</b> Spieler da. Start, sobald das Feld voll ist${T.waitUntil ? ` – spätestens in ${mmss(T.waitUntil - Date.now())}, wenn mindestens ${minP} dabei sind` : ''}.</div>`;
    } else if (T.status === 'starting') {
      st = `<div class="tl-info live">Turnier startet in <b>${mmss((T.startsAt || Date.now()) - Date.now())}</b> – Kamera bereit?</div>`;
    } else if (T.status === 'running') {
      const me = T.players.find((p) => p.id === tId);
      const mine = T.rounds.flat().find((m) => (m.a === tId || m.b === tId) && m.status !== 'bye' && m.status !== 'done');
      st = me && me.out ? `<div class="tl-info">Du bist ausgeschieden – schau zu, wie es weitergeht.</div>`
        : mine && mine.status === 'live' ? `<div class="tl-info live">Dein Match läuft: gegen ${esc(nm(mine.a === tId ? mine.b : mine.a))}</div>`
        : `<div class="tl-info">Warte auf deinen nächsten Gegner …</div>`;
    } else if (T.status === 'done') {
      st = `<div class="tl-champ"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4"/></svg><small>Turniersieger</small><b>${esc(nm(T.champion))}</b>${T.champion === tId ? '<span>Glückwunsch! 🏆</span>' : ''}</div>`;
    }
    $('#tl-status').innerHTML = st;
    $('#tl-count').textContent = `(${T.players.length}/${T.size})`;
    $('#tl-players').innerHTML = T.players.map((p) => `<li><span>${esc(p.name)}${p.id === tId ? ' <span class="muted">(du)</span>' : ''}</span>${p.online ? '' : '<span class="off">offline</span>'}</li>`).join('');
    $('#tl-players-panel').classList.toggle('hidden', T.status === 'running' || T.status === 'done');
    const R = T.rounds.length;
    $('#tl-bracket').innerHTML = R ? T.rounds.map((round, r) => `<div class="b-round"><div class="b-title">${roundName(r, R)}</div>${round.map((m) => {
      const row = (pid, legs, sc) => {
        const cls = [pid === tId ? 'me' : '', m.winner && pid === m.winner ? 'win' : '', m.winner && pid && pid !== m.winner ? 'lose' : ''].join(' ');
        const turn = m.status === 'live' && m.live && m.live.turn === pid;
        return `<div class="b-p ${cls}"><span class="b-n">${pid ? esc(nm(pid)) : m.status === 'bye' ? '<i>Freilos</i>' : '<i>offen</i>'}${turn ? '<i class="b-turn"></i>' : ''}</span>${m.status === 'live' && sc != null ? `<span class="b-sc">${sc}</span>` : ''}<span class="b-l">${m.status === 'bye' || (m.status !== 'done' && T.opts.legs === 1) ? '' : legs}</span></div>`;
      };
      return `<div class="b-m ${m.status}">${m.status === 'live' ? '<span class="b-live">live</span>' : m.walk ? `<span class="b-live walk">${esc(m.walk)}</span>` : ''}${row(m.a, m.legsA, m.live && m.live.a)}${row(m.b, m.legsB, m.live && m.live.b)}</div>`;
    }).join('')}</div>`).join('') : '';
    $('#tl-bracket').classList.toggle('hidden', !R);
    $('#tl-play').classList.toggle('hidden', !(room && room.tourn && game));
    $('#tl-leave').textContent = T.status === 'done' ? 'Zur Startseite' : 'Turnier verlassen';
  }

  // ---------- Navigation ----------
  function goHome(force) {
    if (!force && game && !game.finished && (mode === 'online' || mode === 'local')) {
      const quickOrT = mode === 'online' && room && room.kind !== 'friends';
      if (!confirm(mode === 'online' ? (quickOrT ? 'Spiel verlassen? Das zählt als Aufgabe.' : 'Raum verlassen?') : 'Zur Startseite? (Das Spiel wird gespeichert.)')) return;
    }
    if (tourn) {
      // Turnier läuft weiter im Hintergrund – nur verlassen, wenn es vorbei ist
      if (tourn.status === 'done') leaveTourn(false);
    }
    if (queueing) { send({ t: 'quickcancel' }, true); queueing = null; }
    if (mode === 'online' && !(room && room.tourn)) leaveOnline();
    if (mode === 'local' && game) LS.set('ds.localGame', game);
    if (!(room && room.tourn)) { mode = tourn ? 'tourn' : null; game = null; }
    lsess = null;
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
    // Turnier läuft im Hintergrund? -> zurück zum Turnier
    let tb = $('#go-tback');
    if (tourn && tourn.status !== 'done') {
      if (!tb) { tb = document.createElement('button'); tb.id = 'go-tback'; tb.className = 'resume'; $('#screen-home').prepend(tb); tb.onclick = () => { if (room && room.tourn && game) show('game'); else { renderTLobby(); show('tlobby'); } }; }
      tb.innerHTML = `<span class="r-label">Zurück zum Turnier</span><span class="r-scores"><span><small>${esc(tourn.title)}</small><b>${tourn.status === 'running' ? 'läuft' : tourn.players.length + '/' + tourn.size}</b></span></span>`;
    } else if (tb) tb.remove();
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
  $('#go-online').onclick = () => {
    if (!requireAccount('Online-Spiele', () => $('#go-online').click())) return;
    const A = window.Account;
    $('#on-name').value = settings.name || (A && A.user ? A.user.name.split(' ')[0].slice(0, 16) : '');
    show('online');
  };
  $('#go-cam').onclick = async () => { mode = 'test'; testHits = []; renderTestHits(); show('cam'); if (await camOn()) detector.startTurn(); };
  window.DS.camOn = () => camOn();
  window.DS.camOff = () => camOff();
  window.DS.detector = detector;
  window.DS.setMode = (m) => { mode = m; };
  window.DS.isStreaming = () => !!stream;

  // ---------- Start ----------
  updateTouch();
  renderHome();
  show('home');
  hooks.show.push(() => renderVoiceBtns());
  renderVoiceBtns();
  const params = new URLSearchParams(location.search);
  const inviteCode = params.get('raum');
  const whenAccountReady = (fn) => {
    const A = window.Account;
    if (A && A.ready) return fn();
    const h = () => { window.removeEventListener('account', h); fn(); };
    window.addEventListener('account', h);
  };
  if (params.get('turnier')) {
    history.replaceState(null, '', location.pathname);
    whenAccountReady(() => $('#go-tourn').click());
  } else if (sessionStorage.getItem('ds.tourn')) {
    mode = 'tourn';
    whenAccountReady(() => reconnect());
  } else if (inviteCode) {
    $('#on-name').value = settings.name || '';
    $('#on-code').value = inviteCode.toUpperCase().slice(0, 4);
    history.replaceState(null, '', location.pathname);
    whenAccountReady(() => { if (requireAccount('Online-Spiele', () => { $('#go-online').click(); $('#on-code').value = inviteCode.toUpperCase().slice(0, 4); })) { $('#go-online').click(); $('#on-code').value = inviteCode.toUpperCase().slice(0, 4); } });
  } else if (sessionStorage.getItem('ds.online')) {
    mode = 'online';
    room = { code: JSON.parse(sessionStorage.getItem('ds.online')).code, players: [] };
    whenAccountReady(() => reconnect());
  }
})();
