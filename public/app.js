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
    $('#dlg-settings').showModal();
  };
  $('#s-thr').oninput = (e) => { settings.threshold = Number(e.target.value); $('#s-thr-v').textContent = settings.threshold; detector.threshold = settings.threshold; saveSettings(); };
  $('#s-tip').onchange = (e) => { settings.tipMode = e.target.value; detector.tipMode = settings.tipMode; saveSettings(); };
  $('#s-voice').onchange = (e) => { settings.voice = e.target.checked; saveSettings(); };
  $('#s-autonext').onchange = (e) => { settings.autoNext = e.target.checked; saveSettings(); };

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
    onLargeChange() { /* z. B. Kamera verrückt oder Licht geändert */ },
  });
  detector.threshold = settings.threshold;
  detector.tipMode = settings.tipMode;
  const savedCalib = LS.get('ds.calib', null);
  if (savedCalib && savedCalib.length === 4) detector.setCalibration(savedCalib);

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

  function setCamStatus(s) {
    $('#cam-status').textContent = !stream ? 'Kamera aus' : !detector.H ? 'Bitte kalibrieren' : s;
    const dot = $('#cam-dot');
    dot.className = 'dot ' + (!stream || !detector.H ? '' : detector.phase === 'throw' ? 'live' : 'wait');
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
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (e) {
      toast('Kamera nicht verfügbar: ' + (e.message || e.name), 4000);
      return false;
    }
    video.srcObject = stream;
    try { await video.play(); } catch (_) {}
    $('#cam-off').classList.add('hidden');
    detector.start(video);
    requestWakeLock();
    cancelAnimationFrame(raf);
    draw();
    if (!detector.H) setTimeout(startCalibration, 400);
    else setCamStatus('Bereit');
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
    ctx.drawImage(video, 0, 0, W, H);
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
  let calib = null; // { pts, drag, start, orig }

  function startCalibration() {
    calib = { pts: detector.calib ? detector.calib.map((p) => p.slice()) : [], drag: -1 };
    $('#cam-tools').classList.add('hidden');
    $('#calib-tools').classList.remove('hidden');
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
    h.innerHTML = calib.pts.length < 4
      ? PROMPTS[calib.pts.length]
      : 'Das gelbe Raster muss auf den Drähten liegen. Punkte bei Bedarf ziehen, dann <b>Fertig</b>.';
    $('#c-done').disabled = calib.pts.length < 4;
  }
  $('#c-reset').onclick = () => { calib.pts = []; updateCalibHint(); };
  $('#c-cancel').onclick = () => { stopCalibration(); setCamStatus('Bereit'); };
  $('#c-done').onclick = () => {
    const pts = calib.pts;
    if (!D.solveH(pts, D.CAL_DST)) return toast('Punkte ungültig – bitte neu setzen');
    detector.setCalibration(pts);
    LS.set('ds.calib', pts);
    stopCalibration();
    lastTurnKey = null;
    if (game) syncDetector(); else if (mode === 'test') detector.startTurn();
    toast('Kalibriert ✓');
  };

  function toUV(e) {
    const r = canvas.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (!calib) return;
    e.preventDefault();
    const uv = toUV(e);
    const r = canvas.getBoundingClientRect();
    if (calib.pts.length < 4) {
      calib.pts.push(uv.slice());
      calib.drag = calib.pts.length - 1;
    } else {
      let best = -1, bd = Infinity;
      calib.pts.forEach((p, i) => {
        const d = Math.hypot((p[0] - uv[0]) * r.width, (p[1] - uv[1]) * r.height);
        if (d < bd) { bd = d; best = i; }
      });
      if (bd > 60) return;
      calib.drag = best;
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
  const endDrag = () => { if (calib && calib.drag >= 0) { calib.drag = -1; updateCalibHint(); } };
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
      const p = calib.pts[calib.drag];
      const vw = video.videoWidth, vh = video.videoHeight;
      const R = 70 * dpr, zoom = 3;
      const cx = p[0] < 0.5 ? W - R - 10 * dpr : R + 10 * dpr, cy = R + 10 * dpr;
      const sw = ((2 * R) / zoom) * (vw / W), sh = ((2 * R) / zoom) * (vh / H);
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
      ctx.drawImage(video, p[0] * vw - sw / 2, p[1] * vh - sh / 2, sw, sh, cx - R, cy - R, 2 * R, 2 * R);
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
