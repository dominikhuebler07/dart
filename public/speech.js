// Sprachausgabe: natürlichste verfügbare Stimme, zuverlässige Warteschlange.
// Reihenfolge: 1) Google-Neural-Stimme über den eigenen Server (wenn eingerichtet), 2) beste Stimme des Geräts.
(() => {
  'use strict';
  const synth = window.speechSynthesis;
  const LSget = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } };
  const LSset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };

  const state = Object.assign({ enabled: true, voice: 'auto', rate: 1.0 }, LSget('ds.speech', {}));
  let voices = [], cloud = { enabled: false, voice: '' };
  const queue = [];
  let busy = false, unlocked = false, lastEnd = 0;
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
  fetch('/tts/status').then((r) => (r.ok ? r.json() : null)).then((j) => { if (j && j.enabled) cloud = j; }).catch(() => {});

  // ---------- Entsperren: Browser erlauben Ton erst nach einer Berührung ----------
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    try { if (synth) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; synth.speak(u); } } catch (_) {}
    try { audio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='; audio.play().catch(() => {}); } catch (_) {}
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => window.addEventListener(ev, unlock, { capture: true, passive: true }));

  // ---------- Warteschlange ----------
  function done() { busy = false; lastEnd = Date.now(); setTimeout(next, 60); }

  async function playCloud(text) {
    let url = cache.get(text);
    if (!url) {
      const r = await fetch('/tts?t=' + encodeURIComponent(text));
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
      const u = new SpeechSynthesisUtterance(text);
      const v = pickVoice();
      if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'de-DE';
      u.rate = state.rate;
      let finished = false;
      const end = () => { if (!finished) { finished = true; clearTimeout(t); resolve(); } };
      // Manche Browser melden das Ende nicht – dann nach angemessener Zeit trotzdem weiter
      const t = setTimeout(() => { if (synth.speaking) synth.cancel(); end(); }, 2500 + text.length * 110);
      u.onend = end; u.onerror = end;
      if (synth.paused) synth.resume();
      synth.speak(u);
    });
  }

  async function next() {
    if (busy || !queue.length) return;
    busy = true;
    const text = queue.shift();
    try {
      if (useCloud()) { try { await playCloud(text); } catch (_) { await playDevice(text); } }
      else await playDevice(text);
    } catch (_) {}
    done();
  }

  // Mehrere kurze Ansagen nacheinander (nie als ein Satz mit Punkt – sonst liest z. B. "3. 60" als "dritter 60")
  function say(parts, opts = {}) {
    if (!state.enabled && !opts.force) return;
    const list = (Array.isArray(parts) ? parts : [parts]).map((p) => String(p).trim()).filter(Boolean);
    if (opts.interrupt) { queue.length = 0; if (synth && synth.speaking) synth.cancel(); try { audio.pause(); } catch (_) {} busy = false; }
    // Rückstau vermeiden: ältere Ansagen verwerfen, wenn es sich staut
    while (queue.length > 4) queue.shift();
    queue.push(...list);
    next();
  }

  window.Speech = {
    say,
    get speaking() { return busy || Date.now() - lastEnd < 500; },
    get enabled() { return state.enabled; },
    set enabled(v) { state.enabled = !!v; LSset('ds.speech', state); },
    get voice() { return state.voice; },
    set voice(v) { state.voice = v; LSset('ds.speech', state); },
    get rate() { return state.rate; },
    set rate(v) { state.rate = v; LSset('ds.speech', state); },
    get cloud() { return cloud; },
    voices() { loadVoices(); return voices.map((v) => ({ id: v.voiceURI || v.name, name: v.name, natural: rank(v) >= 80 })); },
    currentName() { return useCloud() ? 'Google Neural (Server)' : (pickVoice() || { name: 'Standardstimme' }).name; },
    test() { say(['Triple 20', 'Hundertachtzig!'], { force: true, interrupt: true }); },
  };
})();
