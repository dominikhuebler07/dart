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

  function speak(text) {
    if (!settings.voice || !('speechSynthesis' in window)) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'de-DE';
      u.rate = 1.05;
      speechSynthesis.speak(u);
    } catch (_) {}
  }

  function show(name) {
    screen = name;
    $$('.screen').forEach((s) => s.classList.toggle('hidden', s.id !== 'screen-' + name));
    const slot = name === 'game' ? $('#cam-slot') : name === 'cam' ? $('#cam-slot-test') : null;
    const panel = $('#cam-panel');
    if (slot) { slot.appendChild(panel); panel.classList.remove('hidden'); }
    else panel.classList.add('hidden');
    $('#room-badge').classList.toggle('hidden', !(mode === 'online' && room));
    if (room) $('#room-badge').textContent = room.code;
    window.scrollTo(0, 0);
  }

  // ---------- Spiel-Einstellungen (Modus / Finish) ----------
  function renderGameSettings(el, editable) {
    const seg = (k, opts) =>
      `<div class="seg" data-k="${k}">${opts
        .map(([v, l]) => `<button type="button" data-v="${v}" class="${String(settings[k]) === String(v) ? 'on' : ''}" ${editable ? '' : 'disabled'}>${l}</button>`)
        .join('')}</div>`;
    el.innerHTML =
      `<div class="lbl">Modus</div>` + seg('startScore', [[301, '301'], [501, '501'], [701, '701']]) +
      `<div class="lbl">Finish</div>` + seg('doubleOut', [[true, 'Double-Out'], [false, 'Single-Out']]) +
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
    $('#local-players').innerHTML = localNames
      .map((n, i) => `<div class="player-row"><input data-i="${i}" value="${esc(n)}" maxlength="16" />${localNames.length > 1 ? `<button type="button" class="ghost" data-del="${i}" title="Entfernen">✕</button>` : ''}</div>`)
      .join('');
  }
  $('#local-players').addEventListener('input', (e) => {
    if (e.target.dataset.i != null) { localNames[e.target.dataset.i] = e.target.value; LS.set('ds.localPlayers', localNames); }
  });
  $('#local-players').addEventListener('click', (e) => {
    const d = e.target.dataset.del;
    if (d != null) { localNames.splice(Number(d), 1); LS.set('ds.localPlayers', localNames); renderLocalPlayers(); }
  });
  $('#add-player').onclick = () => {
    if (localNames.length >= 8) return toast('Maximal 8 Spieler');
    localNames.push('Spieler ' + (localNames.length + 1));
    LS.set('ds.localPlayers', localNames);
    renderLocalPlayers();
  };
  $('#start-local').onclick = () => {
    const players = localNames.map((n, i) => ({ id: 'p' + i, name: n.trim() || 'Spieler ' + (i + 1) }));
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
      game = Game.rematch(game);
      winShownFor = null;
      localChanged();
    },
  };
  function localChanged() { LS.set('ds.localGame', game); update(); }

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
  }

  function renderScoreboard() {
    $('#scoreboard').innerHTML = game.players
      .map((p, i) => {
        const st = Game.stats(game, i);
        const rp = room && room.players.find((x) => x.id === p.id);
        const offline = mode === 'online' && rp && !rp.online;
        const you = mode === 'online' && p.id === myId ? ' <span class="muted">(du)</span>' : '';
        return `<div class="pcard ${i === game.current && !game.finished ? 'active' : ''}">
          <div class="pname"><span>${esc(p.name)}${you}</span>${p.legs ? `<span class="legs">${p.legs} Leg${p.legs > 1 ? 's' : ''}</span>` : ''}</div>
          <div class="pscore">${p.score}</div>
          <div class="pmeta">Ø ${st.avg.toFixed(1)} · ${st.darts} Pfeile ${offline ? '<span class="off">● offline</span>' : ''}</div>
        </div>`;
      })
      .join('');
  }

  function chipHTML(d, i, clickable) {
    if (!d) return `<div class="chip">–</div>`;
    const cls = ['chip', 'filled', d.mult === 2 ? 'd' : d.mult === 3 ? 't' : '', d.void ? 'void' : ''].join(' ');
    return `<div class="${cls}" data-i="${i}" ${clickable ? 'role="button" title="Korrigieren"' : ''}>${B.label(d)}<small>${d.auto ? 'Kamera' : 'manuell'}</small></div>`;
  }

  function renderTurn() {
    const t = game.turn;
    const p = game.players[game.current];
    const mine = myTurn();
    $('#turn-name').textContent = mode === 'online' && !mine ? `${p.name} wirft …` : `${p.name} ist dran`;
    const total = t.darts.filter((d) => !d.void).reduce((s, d) => s + d.value, 0);
    $('#turn-total').textContent = t.bust ? 'BUST' : total ? total : '';
    $('#turn-darts').innerHTML = [0, 1, 2].map((i) => chipHTML(t.darts[i], i, canEdit())).join('');

    let info = '';
    if (t.won) info = `<span class="co">Game shot! 🎯</span>`;
    else if (t.bust) info = `<span class="bust">BUST – überworfen</span> · Pfeile ziehen, dann Weiter`;
    else if (Game.turnComplete(game)) info = 'Pfeile ziehen – dann geht es weiter';
    else {
      const co = Game.checkout(p.score, 3 - t.darts.length, game.doubleOut);
      if (co) info = `<span class="co">Finish: ${co.join(' · ')}</span>`;
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
          <circle r="9" fill="#f2c14e" stroke="#111" stroke-width="2"/>
          <text y="1" font-size="11" font-weight="800" text-anchor="middle" dominant-baseline="central" fill="#111" font-family="system-ui">${i + 1}</text></g>`;
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
      let text = B.speech(d);
      if (t.won) text += '. Game shot!';
      else if (t.bust) text += '. Überworfen';
      else if (cur.n === 3) text += '. ' + t.darts.reduce((s, x) => s + x.value, 0);
      speak(text);
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
    $('#w-undo').classList.toggle('hidden', !canEdit());
    if (!dlg.open) dlg.showModal();
  }
  $('#w-rematch').onclick = () => { $('#dlg-win').close(); act.rematch(); };
  $('#w-undo').onclick = () => { $('#dlg-win').close(); winShownFor = null; act.undo(); };
  $('#w-home').onclick = () => { $('#dlg-win').close(); goHome(); };

  // ---------- Steuerung ----------
  $('#b-miss').onclick = () => { act.dart({ seg: 0, mult: 0 }); detector.rebaseline(); };
  $('#b-undo').onclick = () => act.undo();
  $('#b-next').onclick = () => act.next();
  $('#b-manual').onclick = () => openInput(null);
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
    if (mode === 'test') { testHits.push(d); renderTestHits(); speak(B.speech(d)); return; }
    if (inIndex == null) { act.dart(d); detector.rebaseline(); }
    else act.set(inIndex, d);
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
    $('#dlg-settings').showModal();
  };
  $('#s-thr').oninput = (e) => { settings.threshold = Number(e.target.value); $('#s-thr-v').textContent = settings.threshold; detector.threshold = settings.threshold; saveSettings(); };
  $('#s-tip').onchange = (e) => { settings.tipMode = e.target.value; detector.tipMode = settings.tipMode; saveSettings(); };
  $('#s-voice').onchange = (e) => { settings.voice = e.target.checked; saveSettings(); };
  $('#s-autonext').onchange = (e) => { settings.autoNext = e.target.checked; saveSettings(); };
  $('#s-track').onchange = (e) => { settings.autoTrack = e.target.checked; detector.autoTrack = settings.autoTrack; saveSettings(); };

  // ---------- Erkennung ----------
  let lastTip = null;
  const detector = new D.DartDetector({
    onDart(d, info) {
      lastTip = { u: info.u, v: info.v, t: Date.now(), label: B.label(d) };
      if (mode === 'test') { testHits.push(d); renderTestHits(); speak(B.speech(d)); return; }
      if (!game || game.finished || !myTurn() || Game.turnComplete(game)) return;
      act.dart(d);
    },
    onCleared() {
      if (mode === 'test') { testHits = []; renderTestHits(); return; }
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
  });
  detector.threshold = settings.threshold;
  detector.tipMode = settings.tipMode;
  detector.autoTrack = settings.autoTrack !== false;
  function saveCalib() {
    if (detector.calib) LS.set('ds.cal', { pts: detector.calib, view: detector.view, hz: detector.hz });
  }
  (() => {
    const c = LS.get('ds.cal', null);
    if (c && c.pts && c.pts.length === 4) {
      detector.view = c.view || detector.view;
      detector.hz = c.hz || 1;
      detector.setCalibration(c.pts);
      return;
    }
    const old = LS.get('ds.calib', null); // ältere Version
    if (old && old.length === 4) detector.setCalibration(old);
  })();

  function syncDetector() {
    if (mode === 'test') { if (detector.phase !== 'throw') detector.startTurn(); return; }
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
    if (!detector.H) { lastStatusText = 'Kalibrierung …'; setTimeout(startCalibration, 400); }
    else lastStatusText = 'Bereit';
    setCamStatus();
    if (game) syncDetector();
    return true;
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
      ctx.strokeStyle = '#f2c14e'; ctx.lineWidth = 3 * dpr;
      ctx.beginPath(); ctx.arc(x, y, 9 * dpr, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = 'rgba(0,0,0,.7)';
      ctx.font = `800 ${18 * dpr}px "Barlow Condensed", system-ui`;
      const tw = ctx.measureText(lastTip.label).width;
      ctx.fillRect(x + 12 * dpr, y - 14 * dpr, tw + 12 * dpr, 26 * dpr);
      ctx.fillStyle = '#f2c14e';
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
  function stopCalibration() {
    calib = null;
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
    const q = detector.refineCalibration(pts);
    detector.quality = q ? q.quality : null;
    saveCalib();
    stopCalibration();
    lastTurnKey = null;
    if (game) syncDetector(); else if (mode === 'test') detector.startTurn();
    toast('Kalibriert ✓ – das Raster wird ab jetzt automatisch nachgeführt');
  };

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
      ctx.strokeStyle = '#f2c14e'; ctx.lineWidth = 3 * dpr;
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    }
  }

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
        if (mode === 'online' && room) { toast('Verbindung weg – verbinde neu …'); setTimeout(reconnect, 1500); }
      };
    });
  }

  async function reconnect() {
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

  // ---------- Navigation ----------
  function goHome(force) {
    if (!force && game && !game.finished && (mode === 'online' || mode === 'local')) {
      if (!confirm(mode === 'online' ? 'Raum verlassen?' : 'Zur Startseite? (Das Spiel wird gespeichert.)')) return;
    }
    if (mode === 'online') leaveOnline();
    if (mode === 'local' && game) LS.set('ds.localGame', game);
    mode = null; game = null;
    detector.phase = 'idle';
    renderHome();
    show('home');
  }
  $('#btn-home').onclick = () => goHome(false);

  function renderHome() {
    const saved = LS.get('ds.localGame', null);
    let btn = $('#go-resume');
    if (saved && !saved.finished && saved.players) {
      if (!btn) {
        btn = document.createElement('button');
        btn.id = 'go-resume';
        btn.className = 'big';
        $('.menu').prepend(btn);
        btn.onclick = () => { game = LS.get('ds.localGame', null); if (game) startGameView('local'); };
      }
      btn.innerHTML = `<b>Weiterspielen</b><small>${saved.players.map((p) => esc(p.name) + ' ' + p.score).join(' · ')}</small>`;
    } else if (btn) btn.remove();
  }

  $('#go-local').onclick = () => { renderLocalPlayers(); renderGameSettings($('#local-settings'), true); show('local'); };
  $('#go-online').onclick = () => { $('#on-name').value = settings.name || ''; show('online'); };
  $('#go-cam').onclick = async () => { mode = 'test'; testHits = []; renderTestHits(); show('cam'); if (await camOn()) detector.startTurn(); };

  // ---------- Start ----------
  renderHome();
  show('home');
  const inviteCode = new URLSearchParams(location.search).get('raum');
  if (inviteCode) {
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
