// Geräte koppeln:
//  - Haupt-Handy (Kamera): Code eines Bildschirms oder einer 2. Kamera eingeben
//  - Bildschirm (Fernseher/Laptop): zeigt Spielstand, Ansagen und Kamerabild groß
//  - 2. Kamera (zweites Handy): erkennt Pfeile aus einem anderen Winkel, das Haupt-Handy verrechnet beide
(() => {
  'use strict';
  const DS = window.DS, B = window.Board, Game = window.DartGame;
  const $ = (s) => document.querySelector(s);
  const esc = DS.esc, LS = DS.LS, toast = DS.toast, net = DS.net;

  // ======================= Haupt-Handy =======================
  let devices = [];          // gekoppelte Geräte (vom Server)
  let ctlToken = sessionStorage.getItem('ds.ctlToken') || null;
  const cam2State = new Map(); // Code -> { ready, q, ts }

  function linkCountUpdate() {
    const displays = devices.filter((d) => d.role === 'display' && d.online).length;
    DS.linkCount = displays;
    const n = devices.filter((d) => d.online).length;
    $('#b-link-n').textContent = n ? n : '';
    $('#b-link').classList.toggle('on', n > 0);
    const cams = devices.filter((d) => d.role === 'cam2').length;
    $('#devices-tile-status').textContent = devices.length
      ? [displays ? displays + ' Bildschirm' + (displays > 1 ? 'e' : '') : '', cams ? '2. Kamera' : ''].filter(Boolean).join(' · ') + ' gekoppelt'
      : 'Fernseher/Laptop als Bildschirm · 2. Handy als Kamera';
    if (devices.length) net.keep.add('link'); else net.keep.delete('link');
    renderDeviceLists();
  }
  function renderDeviceLists() {
    const html = devices.length ? devices.map((d) => {
      const st = d.role === 'cam2' ? cam2State.get(d.code) : null;
      const sub = !d.online ? 'getrennt – verbindet sich wieder' : d.role === 'cam2' ? (st && st.ready ? 'bereit, Scheibe erkannt ✓' : 'sucht die Scheibe …') : 'verbunden ✓';
      return `<li><span><b>${d.role === 'cam2' ? '2. Kamera' : 'Bildschirm'}</b> <span class="muted small">${esc(sub)}</span></span><button type="button" class="btn ghost small-btn" data-unlink="${d.code}">Trennen</button></li>`;
    }).join('') : '';
    for (const sel of ['#dv-list', '#lk-list']) { const el = $(sel); if (el) el.innerHTML = html; }
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-unlink]');
    if (!b) return;
    net.send({ t: 'unlink', code: b.dataset.unlink });
    devices = devices.filter((d) => d.code !== b.dataset.unlink);
    linkCountUpdate();
  });

  async function join(code) {
    code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 5) return toast('Der Code hat 5 Zeichen');
    try { await net.connect(); } catch (e) { return toast(e.message); }
    net.keep.add('link');
    net.send({ t: 'linkjoin', code });
  }
  net.on('linkok', (m) => {
    if (m.ctlToken) { ctlToken = m.ctlToken; sessionStorage.setItem('ds.ctlToken', ctlToken); }
    if (!m.resumed) { toast(m.role === 'cam2' ? '2. Kamera gekoppelt ✓' : 'Bildschirm gekoppelt ✓ – Spielstand erscheint dort'); window.Sound && window.Sound.ok(); }
    $('#dv-code').value = ''; $('#lk-code').value = '';
    pushState(true);
  });
  net.on('links', (m) => { devices = m.devices || []; linkCountUpdate(); });
  net.on('dispcmd', (m) => { if (role === 'main' && m.cmd && DS.displayCmd) DS.displayCmd(m.cmd); });
  net.on('linkgone', () => {
    if (role === 'main') { ctlToken = null; sessionStorage.removeItem('ds.ctlToken'); devices = []; linkCountUpdate(); }
  });
  net.on('reconnected', () => { resume(); });
  function resume() {
    if (role === 'main' && ctlToken) net.send({ t: 'linkresume', token: ctlToken });
    if ((role === 'display' || role === 'cam2') && devToken) net.send({ t: 'linkresume', token: devToken });
  }
  $('#dv-join').onclick = () => join($('#dv-code').value);
  $('#lk-join').onclick = () => join($('#lk-code').value);
  $('#dv-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') join($('#dv-code').value); });
  $('#lk-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); join($('#lk-code').value); } });
  $('#b-link').onclick = () => { renderDeviceLists(); $('#dlg-link').showModal(); };
  $('#go-devices').onclick = () => { renderDeviceLists(); DS.show('devices'); };

  // ---------- Spielstand an die Bildschirme ----------
  let sayQueue = [], sayId = 0;
  DS.hooks.speak.push((parts) => { if (DS.linkCount) { sayQueue.push({ id: ++sayId, parts: Array.isArray(parts) ? parts : [parts] }); pushState(true); } });
  const dmap = (d) => ({ l: B.label(d), x: Number.isFinite(d.x) ? Math.round(d.x * 10) / 10 : null, y: Number.isFinite(d.y) ? Math.round(d.y * 10) / 10 : null, m: d.mult, v: !!d.void });
  // letzte Aufnahmen aller Spieler, neueste zuerst (Spieler wechseln sich reihum ab)
  function visits(g, meI) {
    const n = g.players.length, out = [];
    for (let k = 1; k <= 6; k++) {
      const pi = (((g.current - k) % n) + n) % n;
      const H = g.players[pi].history, h = H[H.length - 1 - Math.floor((k - 1) / n)];
      if (!h) break;
      out.push({ p: g.players[pi].name, darts: h.darts.map(dmap), scored: h.scored, bust: !!h.bust, mine: DS.mode === 'local' || pi === meI });
    }
    return out;
  }
  function gameState() {
    const g = DS.game;
    if (!g) return null;
    const meI = DS.meIndex();
    const players = g.players.map((p, i) => {
      const st = Game.stats(g, i);
      return { name: p.name, score: p.score, legs: p.legs || 0, avg: Math.round(st.avg * 10) / 10, darts: st.darts, me: i === meI };
    });
    const t = g.turn, cur = g.players[g.current];
    const total = t.darts.filter((d) => !d.void).reduce((s, d) => s + d.value, 0);
    const co = !g.finished && !t.bust && !Game.turnComplete(g) ? Game.checkout(cur.score, 3 - t.darts.length, g.doubleOut) : null;
    const winner = g.finished ? g.players.find((p) => p.id === g.winner) : null;
    return {
      kind: 'game', mode: DS.mode, startScore: g.startScore, doubleOut: g.doubleOut, current: g.current, players,
      turn: { darts: t.darts.map(dmap), total, bust: !!t.bust, won: !!t.won, done: Game.turnComplete(g) },
      hist: visits(g, meI), edit: !!(DS.canEdit && DS.canEdit()),
      checkout: co, winner: winner ? winner.name : null, room: DS.room ? DS.room.code : null,
    };
  }
  let learnSnap = null;
  DS.hooks.learn.push(() => {
    learnSnap = {
      kind: 'learn', title: $('#lp-title').textContent, stage: $('#lp-stage').textContent,
      label: $('#lp-tlabel').textContent, target: $('#lp-tval').textContent, sub: $('#lp-tsub').textContent,
      metric: $('#lp-metric').textContent, need: $('#lp-need').textContent, progress: parseFloat($('#lp-bar').style.width) || 0,
      darts: [...document.querySelectorAll('#lp-darts .chip')].map((c) => (c.classList.contains('filled') ? c.firstChild.textContent : '')),
    };
    pushState(false);
  });
  DS.hooks.update.push(() => pushState(false));
  DS.hooks.show.push(() => pushState(false));
  let lastPush = 0, pushT = null;
  function pushState(now) {
    if (!DS.linkCount) { sayQueue = []; return; }
    clearTimeout(pushT);
    const go = () => {
      lastPush = Date.now();
      const screenName = document.querySelector('.screen:not(.hidden)');
      const scr = screenName ? screenName.id.replace('screen-', '') : '';
      let state = scr === 'learnplay' && learnSnap ? learnSnap : (scr === 'game' ? gameState() : null);
      if (!state) state = { kind: 'idle', screen: scr };
      state.say = sayQueue.slice(-4);
      try { if (DS.diag) state.diag = DS.diag(); } catch (_) {}
      net.send({ t: 'show', state });
    };
    if (now || Date.now() - lastPush > 250) go(); else pushT = setTimeout(go, 250);
  }
  // regelmäßig auffrischen (falls der Bildschirm neu lädt)
  setInterval(() => { if (DS.linkCount) { sayQueue = sayQueue.filter((s) => s.id > sayId - 4); pushState(false); } }, 2000);

  // ---------- 2. Kamera verrechnen ----------
  const matcher = window.Fuse.createMatcher({
    emit: (d, src) => {
      DS.acceptDart(d, null);
      if (src === 'zweite') toast('Treffer von der 2. Kamera ✓', 1800);
    },
  });
  setInterval(() => matcher.tick(), 100);
  const cam2Ready = () => devices.some((d) => d.role === 'cam2' && d.online && (cam2State.get(d.code) || {}).ready);
  DS.fuse = {
    active: () => role === 'main' && cam2Ready(),
    main: (d, info) => {
      const q = DS.detector.qualityInfo ? (DS.detector.qualityInfo() || {}).mmPerPx : null;
      matcher.main({ ...d, q, info });
    },
  };
  net.on('cam2state', (m) => { cam2State.set(m.code, { ready: m.ready, q: m.q, ts: Date.now() }); renderDeviceLists(); });
  net.on('cam2dart', (m) => {
    if (m.key !== ctlKey || !m.dart || !Number.isFinite(m.dart.x)) return;
    matcher.help({ x: m.dart.x, y: m.dart.y, bdir: m.dart.bdir, q: m.q });
  });
  // Aufnahme-Phase an die 2. Kamera melden
  let ctlKey = null, ctlPhase = null;
  setInterval(() => {
    if (role !== 'main' || !devices.some((d) => d.role === 'cam2')) return;
    const key = String(DS.turnKey() || ''), phase = DS.detector.phase;
    if (key !== ctlKey) matcher.reset();
    if (key !== ctlKey || phase !== ctlPhase) { ctlKey = key; ctlPhase = phase; net.send({ t: 'cam2ctl', phase, key }); }
  }, 200);
  setInterval(() => { if (role === 'main' && devices.some((d) => d.role === 'cam2')) net.send({ t: 'cam2ctl', phase: ctlPhase, key: ctlKey }); }, 5000);

  // ======================= Zusatzgeräte (Bildschirm / 2. Kamera) =======================
  let role = 'main', devToken = null;

  async function startDevice(r) {
    role = r;
    devToken = LS.get('ds.devToken.' + r, null);
    net.keep.add('device');
    try { await net.connect(); } catch (e) { toast(e.message + ' – versuche es weiter …'); }
    if (devToken) net.send({ t: 'linkresume', token: devToken }); else net.send({ t: 'linknew', role: r });
  }
  net.on('open', () => { if (role !== 'main') { /* nach Neustart der Verbindung */ } });
  net.on('linkcode', (m) => {
    devToken = m.token; LS.set('ds.devToken.' + role, devToken);
    if (role === 'display') renderDisplayCode(m.code);
    if (role === 'cam2') { $('#c2-code').textContent = m.code; $('#c2-codebox').classList.remove('hidden'); cam2Status('Warte auf das Haupt-Handy …'); }
  });
  net.on('linked', (m) => {
    devToken = m.token; LS.set('ds.devToken.' + role, devToken);
    if (role === 'display') { disp.linked = true; renderDisplay(); }
    if (role === 'cam2') { $('#c2-codebox').classList.add('hidden'); cam2Status('Gekoppelt ✓ – zählt mit, sobald geworfen wird'); window.Sound && window.Sound.ok(); }
  });
  net.on('unlinked', () => {
    LS.del('ds.devToken.' + role); devToken = null;
    if (role !== 'main') { toast('Das Haupt-Handy hat die Verbindung getrennt.'); net.send({ t: 'linknew', role }); disp.linked = false; disp.state = null; renderDisplay(); }
  });
  net.on('linkgone', () => { if (role !== 'main') { LS.del('ds.devToken.' + role); devToken = null; net.send({ t: 'linknew', role }); } });
  net.on('ctloffline', () => { if (role === 'cam2') cam2Status('Haupt-Handy gerade nicht verbunden …'); if (role === 'display') { disp.offline = true; renderDisplay(); } });

  // ---------- Bildschirm ----------
  const disp = { el: null, linked: false, state: null, img: null, lastSay: 0, sound: false, offline: false };
  function openDisplay() {
    if (!disp.el) {
      disp.el = document.createElement('div');
      disp.el.id = 'display';
      disp.el.className = 'display';
      document.body.appendChild(disp.el);
      disp.el.addEventListener('click', (e) => {
        const pk = e.target.closest('[data-pick]');
        if (pk) { onPick(pk.dataset.pick); return; }
        const dt = e.target.closest('[data-edit]');
        if (dt) { openPicker(dt.dataset.edit); return; }
        const ac = e.target.closest('[data-act]');
        if (ac) { net.send({ t: 'dispcmd', cmd: { kind: ac.dataset.act } }); window.Sound && window.Sound.tap(); return; }
        if (e.target.closest('#dp-sound')) {
          disp.sound = !disp.sound;
          if (disp.sound) window.Speech.enable(); else window.Speech.disable();
          renderDisplay();
        } else if (e.target.closest('#dp-full')) {
          const d = document.documentElement;
          if (!document.fullscreenElement && d.requestFullscreen) d.requestFullscreen().catch(() => {});
          else if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
        } else if (e.target.closest('#dp-exit')) {
          if (!confirm('Bildschirm-Modus beenden?')) return;
          net.send({ t: 'unlink' }); LS.del('ds.devToken.display');
          location.href = location.pathname;
        }
      });
    }
    document.body.classList.add('display-mode');
    startDevice('display');
    renderDisplay();
    requestWake();
  }
  // ---------- Korrigieren am Bildschirm ----------
  // edit: 'cur:0' (Pfeil 1 der aktuellen Aufnahme), 'last:2' (Pfeil 3 der letzten Aufnahme), 'add' (Pfeil eintragen)
  let picker = null;
  function openPicker(edit) {
    const s = disp.state;
    if (!s || s.kind !== 'game') return;
    const [which, i] = edit.split(':');
    let title = 'Pfeil eintragen', cur = null;
    if (which === 'cur') { cur = s.turn.darts[+i]; title = `Pfeil ${+i + 1} korrigieren`; }
    else if (which === 'last') { cur = s.hist[0] && s.hist[0].darts[+i]; title = `${s.hist[0] ? s.hist[0].p + ': ' : ''}Pfeil ${+i + 1} korrigieren`; }
    picker = { which, index: i == null ? null : +i, mult: 1 };
    const div = document.createElement('div');
    div.className = 'dp-picker';
    div.id = 'dp-picker';
    div.innerHTML = `<div class="dp-pk-box"><h2>${esc(title)}${cur ? ` <span class="muted">(jetzt ${esc(cur.l)})</span>` : ''}</h2>
      <div class="dp-pk-mult">${[[1, 'Single'], [2, 'Double'], [3, 'Triple']].map(([m, n]) => `<button data-pick="m${m}" class="${m === 1 ? 'on' : ''}">${n}</button>`).join('')}</div>
      <div class="dp-pk-grid">${Array.from({ length: 20 }, (_, k) => `<button data-pick="n${k + 1}">${k + 1}</button>`).join('')}</div>
      <div class="dp-pk-row"><button data-pick="s25">25</button><button data-pick="sbull">Bull</button><button data-pick="smiss">Miss</button>
        ${which === 'cur' ? '<button data-pick="del" class="warn">Löschen</button>' : ''}<button data-pick="x" class="ghost">Abbrechen</button></div></div>`;
    closePicker();
    disp.el.appendChild(div);
  }
  function closePicker() { const p = document.getElementById('dp-picker'); if (p) p.remove(); }
  function onPick(v) {
    if (!picker) return closePicker();
    if (v === 'x') { picker = null; return closePicker(); }
    if (v[0] === 'm') {
      picker.mult = +v.slice(1);
      document.querySelectorAll('#dp-picker .dp-pk-mult button').forEach((b) => b.classList.toggle('on', b.dataset.pick === v));
      return;
    }
    let cmd;
    if (v === 'del') cmd = { kind: 'remove', index: picker.index };
    else {
      const dart = v === 's25' ? { seg: 25, mult: 1 } : v === 'sbull' ? { seg: 25, mult: 2 } : v === 'smiss' ? { seg: 0, mult: 0 } : { seg: +v.slice(1), mult: picker.mult };
      cmd = picker.which === 'add' ? { kind: 'add', dart } : { kind: 'correct', which: picker.which, index: picker.index, dart };
    }
    net.send({ t: 'dispcmd', cmd });
    window.Sound && window.Sound.tap();
    picker = null; closePicker();
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && picker) { picker = null; closePicker(); } });

  async function requestWake() { try { if ('wakeLock' in navigator) await navigator.wakeLock.request('screen'); } catch (_) {} }
  document.addEventListener('visibilitychange', () => { if (role === 'display' && document.visibilityState === 'visible') requestWake(); });
  function renderDisplayCode(code) {
    disp.code = code; disp.linked = false;
    renderDisplay();
  }
  // Diagnose (?bildschirm&diagnose): Messwerte des Handys anzeigen – zur Fehlersuche am echten Aufbau
  function renderDiag(d) {
    if (!disp.diagOn) return;
    let el = document.getElementById('dp-diag');
    if (!el) { el = document.createElement('pre'); el.id = 'dp-diag'; el.className = 'dp-diag'; document.body.appendChild(el); }
    if (!d) { el.textContent = 'Diagnose: noch keine Daten vom Handy (Handy koppeln, Spiel starten, Kamera an)'; return; }
    el.textContent = Object.entries(d).map(([k, v]) => k.padEnd(10) + ' ' + (typeof v === 'object' ? JSON.stringify(v) : v)).join('\n');
  }
  net.on('show', (m) => {
    renderDiag(m.state && m.state.diag);
    if (role !== 'display') return;
    disp.linked = true; disp.offline = false;
    const prev = disp.state;
    disp.state = m.state;
    // Ansagen (falls am Bildschirm Ton an ist)
    for (const s of (m.state.say || [])) if (s.id > disp.lastSay) { disp.lastSay = s.id; if (disp.sound && prev) window.Speech.say(s.parts); }
    if (!prev && m.state.say && m.state.say.length) disp.lastSay = m.state.say[m.state.say.length - 1].id;
    renderDisplay();
  });
  net.on('frame', (m) => {
    if (role !== 'display' || m.from !== 'me') return;
    disp.img = m.img;
    const im = document.getElementById('dp-img');
    if (im) im.src = m.img;
  });
  const QR_URL = (code) => location.origin + location.pathname + '?koppeln=' + code;
  function boardSvg(darts) {
    const hits = (darts || []).filter((d) => d.x != null).map((d, i) => `<g transform="translate(${d.x} ${d.y})"><circle r="11" fill="#ece0bf" stroke="#131518" stroke-width="3"/><text y="1" font-size="14" font-weight="800" text-anchor="middle" dominant-baseline="central" fill="#131518">${i + 1}</text></g>`).join('');
    return B.svg(hits);
  }
  // Letzte Aufnahmen: neueste oben; die allerletzte ist korrigierbar, solange die neue Aufnahme noch leer ist
  function histHtml(s) {
    if (!s.hist || !s.hist.length) return '';
    const canLast = s.turn.darts.length === 0 && s.hist[0].mine && !s.winner;
    return `<div class="dp-hist"><div class="dp-hist-t">Letzte Aufnahmen${canLast ? ' <span class="muted">– Pfeil antippen zum Korrigieren</span>' : ''}</div>
      ${s.hist.slice(0, 5).map((h, k) => `<div class="dp-h ${k === 0 ? 'new' : ''}"><span class="dp-hn">${esc(h.p)}</span>
        <span class="dp-hd">${[0, 1, 2].map((i) => { const d = h.darts[i]; const ed = d && k === 0 && canLast ? ` data-edit="last:${i}"` : ''; return `<span class="dp-hc ${d && d.m === 3 ? 't' : d && d.m === 2 ? 'd' : ''} ${ed ? 'ed' : ''}"${ed}>${d ? esc(d.l) : '–'}</span>`; }).join('')}</span>
        <span class="dp-hs ${h.scored === 180 ? 'max' : ''}">${h.bust ? 'Bust' : h.scored}</span></div>`).join('')}</div>`;
  }
  function renderDisplay() {
    if (!disp.el) return;
    const top = `<div class="dp-bar"><span class="dp-brand"><img src="logo.svg" alt="" width="34" height="34"/>DartScan</span>
      <span class="dp-tools"><button id="dp-sound" class="dp-btn ${disp.sound ? 'on' : ''}">${disp.sound ? 'Ton an' : 'Ton aus'}</button><button id="dp-full" class="dp-btn">Vollbild</button><button id="dp-exit" class="dp-btn">Beenden</button></span></div>`;
    if (!disp.linked) {
      const code = disp.code || '·····';
      let qr = '';
      try { if (disp.code) qr = window.QR.svg(QR_URL(disp.code)); } catch (_) {}
      disp.el.innerHTML = top + `<div class="dp-pair">
        <div class="dp-pair-text"><h1>Bildschirm koppeln</h1>
          <ol><li>Am Handy DartScan öffnen</li><li><b>Geräte koppeln</b> antippen (oder im Spiel das Bildschirm-Symbol)</li><li>Diesen Code eingeben – oder den QR-Code mit der Handykamera scannen</li></ol>
          <div class="dp-code">${esc(code)}</div></div>
        <div class="dp-qr">${qr}</div></div>`;
      return;
    }
    const s = disp.state;
    let body = '';
    if (!s || s.kind === 'idle') {
      body = `<div class="dp-idle"><h1>Gekoppelt ✓</h1><p>${disp.offline ? 'Das Handy ist gerade nicht verbunden …' : 'Starte am Handy ein Spiel – der Spielstand erscheint hier.'}</p>${disp.img ? '<img id="dp-img" class="dp-idle-img" alt="Kamerabild"/>' : ''}</div>`;
    } else if (s.kind === 'learn') {
      body = `<div class="dp-grid"><div class="dp-main"><div class="dp-learn">
        <small>${esc(s.stage)}</small><h1>${esc(s.title)}</h1>
        <div class="dp-tlabel">${esc(s.label)}</div><div class="dp-target">${esc(s.target)}</div><div class="dp-tsub">${esc(s.sub)}</div>
        <div class="dp-prog"><i style="width:${s.progress}%"></i></div><div class="dp-metric">${esc(s.metric)} · ${esc(s.need)}</div>
        <div class="dp-darts">${[0, 1, 2].map((i) => `<div class="dp-dart ${s.darts[i] ? 'f' : ''}">${esc(s.darts[i] || '–')}</div>`).join('')}</div></div></div>
        <div class="dp-side"><img id="dp-img" class="dp-cam" alt="Kamerabild"/></div></div>`;
    } else {
      const cur = s.players[s.current];
      body = `<div class="dp-grid"><div class="dp-main">
        <div class="dp-players n${Math.min(4, s.players.length)}">${s.players.map((p, i) => `<div class="dp-p ${i === s.current && !s.winner ? 'on' : ''}">
          <div class="dp-pn">${esc(p.name)}${p.legs ? ` <span class="dp-legs">${p.legs} Leg${p.legs > 1 ? 's' : ''}</span>` : ''}</div>
          <div class="dp-ps">${p.score}</div><div class="dp-pm">Ø ${String(p.avg).replace('.', ',')} · ${p.darts} Pfeile</div></div>`).join('')}</div>
        <div class="dp-turn"><div class="dp-tn">${s.winner ? esc(s.winner) + ' gewinnt!' : esc(cur.name) + ' wirft'}</div>
          <div class="dp-darts">${[0, 1, 2].map((i) => { const d = s.turn.darts[i]; const ed = d && s.edit ? ` data-edit="cur:${i}" title="Antippen zum Korrigieren"` : ''; return `<div class="dp-dart ${d ? 'f' : ''} ${d && d.m === 3 ? 't' : d && d.m === 2 ? 'd' : ''} ${ed ? 'ed' : ''}"${ed}>${d ? esc(d.l) : '–'}</div>`; }).join('')}
            <div class="dp-total ${s.turn.total === 180 ? 'max' : ''}">${s.turn.bust ? 'Bust' : s.turn.total || ''}</div></div>
          <div class="dp-co">${s.checkout ? 'Finish: ' + s.checkout.map((c) => `<b>${esc(c)}</b>`).join(' ') : s.turn.done && !s.winner ? 'Pfeile ziehen …' : ''}</div>
          ${s.edit && !s.winner ? `<div class="dp-acts">${s.turn.darts.length < 3 && !s.turn.done ? '<button data-edit="add" class="dp-btn">+ Pfeil eintragen</button>' : ''}<button data-act="undo" class="dp-btn">↶ Zurück</button><button data-act="next" class="dp-btn on">Weiter →</button></div>` : ''}</div>
        ${histHtml(s)}
      </div>
      <div class="dp-side"><img id="dp-img" class="dp-cam" alt="Kamerabild"/><div class="dp-board ${s.turn.darts.length ? '' : 'old'}">${boardSvg(s.turn.darts.length ? s.turn.darts : (s.hist && s.hist[0] ? s.hist[0].darts : []))}</div>
        <div class="dp-mode">${s.startScore} · ${s.doubleOut ? 'Double-Out' : 'Single-Out'}${s.room ? ' · Online ' + esc(s.room) : ''}</div></div></div>`;
    }
    const pk = document.getElementById('dp-picker');
    disp.el.innerHTML = top + body;
    if (pk && picker) disp.el.appendChild(pk); // Auswahl bleibt offen, auch wenn ein neuer Spielstand kommt
    const im = document.getElementById('dp-img');
    if (im) { if (disp.img) im.src = disp.img; else im.classList.add('empty'); }
  }

  // ---------- 2. Kamera (zweites Handy) ----------
  function cam2Status(t) { $('#c2-state').innerHTML = `<div class="tl-info">${esc(t)}</div>`; }
  async function openCam2() {
    DS.setMode('cam2');
    DS.show('cam2');
    startDevice('cam2');
    await DS.camOn();
    DS.detector.phase = 'idle';
  }
  let c2key = null;
  net.on('cam2ctl', (m) => {
    if (role !== 'cam2') return;
    const det = DS.detector;
    if (m.key !== c2key) { c2key = m.key; if (det.H) det.startTurn(); }
    det.phase = m.phase === 'throw' ? 'throw' : m.phase === 'pull' ? 'pull' : 'idle';
  });
  DS.cam2Dart = (d) => {
    if (role !== 'cam2') return;
    const q = (DS.detector.qualityInfo() || {}).mmPerPx;
    net.send({ t: 'cam2dart', dart: { x: d.x, y: d.y, bdir: d.bdir }, q, key: c2key });
  };
  setInterval(() => {
    if (role !== 'cam2') return;
    const det = DS.detector;
    const ready = !!(det.H && !det.lost && DS.isStreaming());
    net.send({ t: 'cam2state', ready, q: ready ? (det.qualityInfo() || {}).mmPerPx : null });
  }, 2500);
  $('#c2-stop').onclick = () => {
    net.send({ t: 'unlink' }); LS.del('ds.devToken.cam2');
    location.href = location.pathname;
  };

  $('#dv-display').onclick = () => openDisplay();
  $('#dv-cam2').onclick = () => openCam2();

  // ---------- Start über Link ----------
  const p = new URLSearchParams(location.search);
  if (p.has('bildschirm') || p.has('tv')) {
    disp.diagOn = p.has('diagnose');
    history.replaceState(null, '', location.pathname + '?bildschirm' + (disp.diagOn ? '&diagnose' : ''));
    openDisplay();
  }
  else if (p.has('kamera2')) { history.replaceState(null, '', location.pathname); openCam2(); }
  else if (p.get('koppeln')) {
    const code = p.get('koppeln');
    history.replaceState(null, '', location.pathname);
    $('#dv-code').value = code.toUpperCase().slice(0, 5);
    DS.show('devices');
    join(code);
  } else if (ctlToken) {
    // Seite neu geladen: Kopplung wiederherstellen
    net.keep.add('link');
    net.connect().then(() => net.send({ t: 'linkresume', token: ctlToken })).catch(() => {});
  }
})();
