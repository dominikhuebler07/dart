// Sprachausgabe: natürlichste verfügbare Stimme, zuverlässige Warteschlange.
// Reihenfolge: 1) Google-Neural-Stimme über den eigenen Server (wenn eingerichtet), 2) beste Stimme des Geräts.
(() => {
  'use strict';
  const synth = window.speechSynthesis;
  const LSget = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } };
  const LSset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };

  // Stimme und Tempo werden gespeichert. Ein/Aus NICHT: Browser erlauben Ton erst nach einem Tipp,
  // deshalb startet die Ansage immer aus und wird mit dem Lautsprecher-Knopf (= Tipp) eingeschaltet.
  const saved = LSget('ds.speech', {});
  const state = { enabled: false, voice: saved.voice || 'auto', rate: saved.rate || 1.0 };
  const persist = () => LSset('ds.speech', { voice: state.voice, rate: state.rate });
  let voices = [], cloud = { enabled: false, voice: '' };
  const queue = [];
  let busy = false, unlocked = false, lastEnd = 0;
  const alive = new Set();          // Chrome verwirft sonst Äußerungen (onend kommt nie) -> Warteschlange hängt
  let cloudFailUntil = 0;           // Server-Stimme nach Fehler/Langsamkeit kurz pausieren
  let busySince = 0;
  const audio = new Audio();
  audio.preload = 'auto';
  const cache = new Map(); // Text -> Object-URL (Server-Stimme)

  // ---------- Stimmen bewerten: neuronale/natürliche zuerst, Roboterstimmen zuletzt ----------
  function rank(v) {
    const n = v.name || '';
    let s = 0;
    if (/natural|neural|wavenet|neural2|studio|journey|chirp/i.test(n)) s += 100;   // Edge "Katja Online (Natural)", …
    if (/premium|enhanced|erweitert|verbessert|siri/i.test(n)) s += 85;               // iPhone/Mac Premium-Stimmen
    if (/google/i.test(n)) s += 60;                                                   // Google Deutsch (Chrome/Android)
    if (/online/i.test(n)) s += 20;
    if (v.localService === false) s += 10;
    if (/^de-DE/i.test(v.lang)) s += 5;
    if (/hedda|stefan|desktop|espeak|katja(?!.*natural)/i.test(n)) s -= 40;          // klassische Roboterstimmen
    return s;
  }
  function loadVoices() {
    if (!synth) return;
    voices = synth.getVoices().filter((v) => /^de(-|_|$)/i.test(v.lang)).sort((a, b) => rank(b) - rank(a));
  }
  if (synth) { loadVoices(); synth.onvoiceschanged = loadVoices; setTimeout(loadVoices, 500); setTimeout(loadVoices, 2000); }

  function pickVoice() {
    if (state.voice && state.voice !== 'auto' && state.voice !== 'cloud') {
      const v = voices.find((x) => x.voiceURI === state.voice || x.name === state.voice);
      if (v) return v;
    }
    return voices[0] || null;
  }
  const useCloud = () => cloud.enabled && (state.voice === 'cloud' || (state.voice === 'auto' && !(voices[0] && rank(voices[0]) >= 100)));

  // Server-Stimme verfügbar?
  fetch('/tts/status').then((r) => (r.ok ? r.json() : null)).then((j) => { if (j && j.enabled) { cloud = j; setTimeout(warmup, 1000); } }).catch(() => {});

  // ---------- Entsperren: Browser erlauben Ton erst nach einer Berührung ----------
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    try { if (synth) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; synth.speak(u); } } catch (_) {}
    try { audio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='; audio.play().catch(() => {}); } catch (_) {}
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => window.addEventListener(ev, unlock, { capture: true, passive: true }));

  // ---------- Warteschlange ----------
  let ttsEnd = 0;
  function done() { busy = false; lastEnd = Date.now(); ttsEnd = Date.now(); setTimeout(next, 60); }

  async function playCloud(text) {
    let url = cache.get(text);
    if (!url) {
      // Server schläft (Gratis-Hosting) oder ist langsam -> nicht warten, sondern sofort Gerätestimme
      const ac = window.AbortController ? new AbortController() : null;
      const to = setTimeout(() => ac && ac.abort(), 1500);
      let r;
      try { r = await fetch('/tts?t=' + encodeURIComponent(text), ac ? { signal: ac.signal } : undefined); }
      finally { clearTimeout(to); }
      if (!r.ok) throw new Error('tts ' + r.status);
      url = URL.createObjectURL(await r.blob());
      cache.set(text, url);
      if (cache.size > 300) { const k = cache.keys().next().value; URL.revokeObjectURL(cache.get(k)); cache.delete(k); }
    }
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, 6000);
      audio.onended = () => { clearTimeout(t); resolve(); };
      audio.onerror = () => { clearTimeout(t); reject(new Error('audio')); };
      audio.src = url;
      audio.playbackRate = state.rate;
      audio.play().catch((e) => { clearTimeout(t); reject(e); });
    });
  }

  function playDevice(text) {
    return new Promise((resolve) => {
      if (!synth) return resolve();
      // hängt die Sprachausgabe noch an einer alten Äußerung (bekannter Chrome-Fehler)? -> zurücksetzen
      if (synth.speaking && !alive.size) synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      alive.add(u);
      const v = pickVoice();
      if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'de-DE';
      u.rate = state.rate;
      let finished = false;
      const end = () => { if (!finished) { finished = true; clearTimeout(t); alive.delete(u); resolve(); } };
      // Manche Browser melden das Ende nicht – dann nach angemessener Zeit trotzdem weiter
      const t = setTimeout(() => { if (synth.speaking) synth.cancel(); end(); }, 2500 + text.length * 110);
      u.onend = end; u.onerror = end;
      if (synth.paused) synth.resume();
      synth.speak(u);
      // Chrome startet manchmal nicht (bleibt "pending") -> einmal anstoßen
      let started = false;
      u.onstart = () => { started = true; };
      setTimeout(() => { if (!finished && !started && !synth.speaking) { synth.cancel(); synth.speak(u); } }, 700);
    });
  }

  async function next() {
    // Sicherheitsnetz: steckt die Warteschlange länger als 8 s, freigeben
    if (busy && Date.now() - busySince > 8000) { busy = false; if (synth) synth.cancel(); alive.clear(); }
    if (busy || !queue.length) return;
    busy = true; busySince = Date.now();
    const text = queue.shift();
    try {
      if (useCloud() && Date.now() > cloudFailUntil) {
        try { await playCloud(text); }
        catch (_) { cloudFailUntil = Date.now() + 60000; await playDevice(text); }
      } else await playDevice(text);
    } catch (_) {}
    done();
  }
  // Nach dem Zurückkehren in die App (Bildschirm aus/an, App-Wechsel) hängt die Sprachausgabe oft -> zurücksetzen
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    try { if (synth) { synth.cancel(); if (synth.paused) synth.resume(); } } catch (_) {}
    alive.clear(); busy = false; setTimeout(next, 100);
  });
  // Server-Stimme vorwärmen (weckt einen schlafenden Server, lädt häufige Ansagen in den Zwischenspeicher)
  function warmup() {
    if (!cloud.enabled) return;
    ['Hundertachtzig!', 'Game shot!', 'Überworfen'].forEach((t) => {
      if (cache.has(t)) return;
      fetch('/tts?t=' + encodeURIComponent(t)).then((r) => (r.ok ? r.blob() : null)).then((b) => { if (b) cache.set(t, URL.createObjectURL(b)); }).catch(() => {});
    });
  }

  // Mehrere kurze Ansagen nacheinander (nie als ein Satz mit Punkt – sonst liest z. B. "3. 60" als "dritter 60")
  function say(parts, opts = {}) {
    if (!state.enabled && !opts.test) return;
    const list = (Array.isArray(parts) ? parts : [parts]).map((p) => String(p).trim()).filter(Boolean);
    if (opts.interrupt) { queue.length = 0; if (synth && synth.speaking) synth.cancel(); alive.clear(); try { audio.pause(); } catch (_) {} busy = false; }
    // Rückstau vermeiden: ältere Ansagen verwerfen, wenn es sich staut
    while (queue.length > 4) queue.shift();
    queue.push(...list);
    next();
  }

  // ---------- Signaltöne (wie bei Sprachassistenten) ----------
  let actx = null;
  function ctx() {
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
    } catch (_) {}
    return actx;
  }
  window.addEventListener('pointerdown', () => ctx(), { capture: true, passive: true });
  // notes: [[Frequenz Hz, Start s, Dauer s], …]
  function tones(notes, vol = 0.22) {
    const c = ctx();
    if (!c) return;
    const t0 = c.currentTime + 0.02;
    for (const [f, st, du] of notes) {
      const o = c.createOscillator(), g = c.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, t0 + st);
      g.gain.linearRampToValueAtTime(vol, t0 + st + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + st + du);
      o.connect(g).connect(c.destination);
      o.start(t0 + st); o.stop(t0 + st + du + 0.05);
    }
    lastEnd = Date.now() + 400; // eigene Töne nicht als Sprache werten
  }
  // ---------- Spiel-Sounds (selbst erzeugt, keine Dateien) ----------
  let sfxOn = LSget('ds.sfx', true);
  let noiseBuf = null;
  function noise(c) {
    if (noiseBuf) return noiseBuf;
    noiseBuf = c.createBuffer(1, c.sampleRate * 0.6, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return noiseBuf;
  }
  // kurzer Rausch-Impuls durch einen Filter (Einschlag, Wusch)
  function burst(c, t, { dur = 0.12, freq = 2500, q = 1, type = 'bandpass', vol = 0.3, sweep = 0 } = {}) {
    const src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    src.buffer = noise(c); f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (sweep) f.frequency.exponentialRampToValueAtTime(sweep, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(c.destination); src.start(t); src.stop(t + dur + 0.05);
  }
  function thump(c, t, { f0 = 180, f1 = 60, dur = 0.16, vol = 0.45, type = 'sine' } = {}) {
    const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.05);
  }
  function note(c, t, f, dur, vol = 0.16, type = 'triangle') {
    const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.05);
  }
  function sfx(fn) {
    if (!sfxOn) return;
    const c = ctx();
    if (!c || c.state !== 'running') return;
    try { fn(c, c.currentTime + 0.01); } catch (_) {}
  }
  const Sound = {
    wake: () => tones([[660, 0, 0.16], [990, 0.11, 0.24]]),        // "ich höre"
    ok: () => tones([[880, 0, 0.12], [1320, 0.09, 0.2]], 0.18),     // erledigt
    err: () => tones([[440, 0, 0.18], [330, 0.15, 0.28]], 0.2),     // nicht verstanden
    // Pfeil steckt: dumpfer Einschlag (Triple/Double etwas heller, Miss leise)
    hit: (mult = 1) => sfx((c, t) => {
      if (!mult) { burst(c, t, { dur: 0.09, freq: 900, vol: 0.08 }); return; }
      thump(c, t, { f0: 210, f1: 70, dur: 0.14, vol: 0.5 });
      burst(c, t, { dur: 0.05, freq: 3200, q: 0.8, vol: 0.22 });
      if (mult > 1) note(c, t + 0.05, mult === 3 ? 1568 : 1319, 0.22, 0.09, 'sine');
    }),
    // 180: kleine Fanfare
    max: () => sfx((c, t) => { [523, 659, 784, 1047].forEach((f, i) => note(c, t + i * 0.09, f, 0.32 + (i === 3 ? 0.4 : 0), 0.15)); burst(c, t + 0.27, { dur: 0.6, freq: 6000, type: 'highpass', vol: 0.07 }); }),
    // Aufnahme mit 100+ (Ton steigt mit)
    good: (v = 100) => sfx((c, t) => { const f = 523 + Math.min(1, (v - 100) / 80) * 260; note(c, t, f, 0.16, 0.12); note(c, t + 0.1, f * 1.5, 0.26, 0.12); }),
    bust: () => sfx((c, t) => { note(c, t, 311, 0.22, 0.16, 'sawtooth'); note(c, t + 0.18, 233, 0.4, 0.14, 'sawtooth'); }),
    // Spiel gewonnen
    win: () => sfx((c, t) => { [523, 659, 784, 659, 784, 1047].forEach((f, i) => note(c, t + i * 0.12, f, i === 5 ? 0.9 : 0.2, 0.15)); burst(c, t + 0.6, { dur: 0.9, freq: 7000, type: 'highpass', vol: 0.08 }); }),
    // nächster Spieler / weiter
    turn: () => sfx((c, t) => burst(c, t, { dur: 0.22, freq: 600, sweep: 2400, q: 0.7, vol: 0.12 })),
    // Knopf gedrückt (leise)
    tap: () => sfx((c, t) => burst(c, t, { dur: 0.03, freq: 2200, q: 2, vol: 0.06 })),
    get on() { return sfxOn; },
    set on(v) { sfxOn = !!v; LSset('ds.sfx', sfxOn); },
  };
  window.Sound = Sound;

  // Einschalten MUSS direkt im Klick passieren: dann gibt der Browser Sprachausgabe und Audio frei.
  function enable() {
    state.enabled = true;
    unlocked = false; unlock();
    try {
      if (synth) {
        synth.cancel(); if (synth.paused) synth.resume();
        loadVoices();
        const u = new SpeechSynthesisUtterance('Ansage an');
        const v = pickVoice();
        if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'de-DE';
        u.rate = state.rate;
        synth.speak(u);
      }
    } catch (_) {}
    alive.clear(); busy = false; queue.length = 0;
    setTimeout(warmup, 300);
  }
  function disable() {
    state.enabled = false;
    queue.length = 0;
    try { if (synth) synth.cancel(); audio.pause(); } catch (_) {}
    alive.clear(); busy = false;
  }

  window.Speech = {
    say, enable, disable,
    get speaking() { return busy || Date.now() - lastEnd < 500; },
    get talking() { return busy || Date.now() - ttsEnd < 350; }, // nur die Sprachausgabe selbst (ohne Signaltöne)
    get enabled() { return state.enabled; },
    set enabled(v) { if (v) enable(); else disable(); },
    get voice() { return state.voice; },
    set voice(v) { state.voice = v; persist(); },
    get rate() { return state.rate; },
    set rate(v) { state.rate = v; persist(); },
    get cloud() { return cloud; },
    voices() { loadVoices(); return voices.map((v) => ({ id: v.voiceURI || v.name, name: v.name, natural: rank(v) >= 80 })); },
    currentName() { return useCloud() ? 'Google Neural (Server)' : (pickVoice() || { name: 'Standardstimme' }).name; },
    test() { unlocked = false; unlock(); say(['Triple 20', 'Hundertachtzig!'], { test: true, interrupt: true }); },
  };
})();
