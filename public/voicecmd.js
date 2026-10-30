// Sprachbefehle erkennen. Beispiele:
//   "Dartcounter, korrigiere auf Triple 20"             -> letzter Pfeil
//   "Dartcounter, korrigiere den zweiten Pfeil auf 16"   -> Pfeil 2
//   "Korrigiere 4 auf 18. Korrigiere 13 auf 1"          -> Pfeil mit dem Wert 4 bzw. 13 (geht auch ohne Aktivierungswort)
//   "Korrigiere 4 auf 18 und 13 auf 1"                  -> mehrere auf einmal
//   "Dartcounter weiter" / "Dartcounter zurück"
// Läuft im Browser und in den Tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VoiceCmd = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const NUM = {
    null: 0, eins: 1, ein: 1, eine: 1, einen: 1, zwei: 2, zwo: 2, drei: 3, vier: 4, für: 4, fünf: 5, fuenf: 5, sechs: 6, sex: 6, sieben: 7,
    acht: 8, neun: 9, zehn: 10, elf: 11, zwölf: 12, zwoelf: 12, dreizehn: 13, vierzehn: 14, fünfzehn: 15, fuenfzehn: 15,
    sechzehn: 16, siebzehn: 17, achtzehn: 18, neunzehn: 19, zwanzig: 20, fünfundzwanzig: 25, fuenfundzwanzig: 25, fünfzig: 50, fuenfzig: 50,
  };
  const MULT = [
    [/^(?:triple|tripel|tripple|trippel|treble|triebel|tribble|triple?s|dreifach|dreifache[nrs]?|t)$/, 3],
    [/^(?:double|doppel|doppelt|doppelte[nrs]?|dobble|dabble|dubble|doble|d)$/, 2],
    [/^(?:single|einfach|einfache[nrs]?|einzel|einzelne[nrs]?|s)$/, 1],
  ];
  const ORD = [
    [/^(?:erste[nrms]?|1\.)$/, 0],
    [/^(?:zweite[nrms]?|2\.)$/, 1],
    [/^(?:dritte[nrms]?|3\.)$/, 2],
    [/^(?:letzte[nrms]?)$/, null],
  ];
  const VERB_CORRECT = /\b(?:korrigier\w*|korigier\w*|korrektur|korrigiere|änder\w*|aender\w*|setz\w*|stell\w*|mach\w*|ersetz\w*)\b/;
  const VERB_DIRECT = /\b(?:korrigier\w*|korigier\w*|änder\w*|aender\w*)\b/; // eindeutig genug für Befehle ohne Aktivierungswort
  const VERB_ADD = /\b(?:eintrag\w*|trag\w*|hinzu\w*|notier\w*)\b/;

  function normalize(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/ß/g, 'ss')
      .replace(/(\d)\.(?=\s|$)/g, '$1. ')
      .replace(/[^\p{L}\d. ]+/gu, ' ')
      .replace(/\b([tds])\s?-?(\d{1,2})\b/g, '$1 $2') // "T20" -> "t 20"
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ---------- Aktivierungswort, unscharf (Spracherkennung hört aus der Entfernung oft "Dart Kanter", "Kartcounter" …) ----------
  function lev(a, b) {
    const m = a.length, n = b.length;
    if (Math.abs(m - n) > 4) return 99;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  }
  const WAKES = ['dartcounter', 'dartscounter', 'dartscan', 'dartcount', 'dartkounter'];
  // Liefert die Position (Zeichen) direkt hinter dem Aktivierungswort oder -1
  function findWake(t) {
    const words = t.split(' ');
    let pos = 0;
    const starts = words.map((w) => { const s = pos; pos += w.length + 1; return s; });
    let best = null;
    for (let i = 0; i < words.length; i++) {
      let joined = '';
      for (let k = i; k < Math.min(words.length, i + 3); k++) {
        joined += words[k];
        if (joined.length < 6 || joined.length > 15) continue;
        // muss mit d/t/k (dart, tart, kart) beginnen – sonst zu viele Zufallstreffer
        if (!/^[dtk]/.test(joined)) continue;
        const d = Math.min(...WAKES.map((w) => lev(joined, w)));
        const lim = joined.length >= 10 ? 3 : 1;
        if (d <= lim && (!best || d < best.d)) best = { d, end: starts[k] + words[k].length };
      }
    }
    return best ? best.end : -1;
  }

  // Feld aus Text, z. B. "triple 20", "doppel sechzehn", "bull", "daneben" -> {seg, mult} oder null
  function parseField(text) {
    const t = normalize(text).replace(/\./g, ' ').replace(/\s+/g, ' ').trim(); // "18." am Satzende ist keine Ordnungszahl
    if (!t) return null;
    if (/\b(?:miss|mis|daneben|vorbei|nichts|kein treffer|null|0)\b/.test(t)) return { seg: 0, mult: 0 };
    if (/\b(?:bull|bulls|bullseye|bullauge|bullen|boll|pull)\b/.test(t)) {
      if (/\b(?:single|einfach|einfaches|25|fünfundzwanzig|fuenfundzwanzig|grün|gruen|aussen|äusseres|kleines)\b/.test(t)) return { seg: 25, mult: 1 };
      return { seg: 25, mult: 2 };
    }
    const tokens = t.split(' ');
    let mult = null, num = null;
    for (let i = 0; i < tokens.length; i++) {
      const w = tokens[i];
      const m = MULT.find(([re]) => re.test(w));
      if (m && mult == null) { mult = m[1]; continue; }
      let n = null;
      if (/^\d{1,2}$/.test(w)) n = Number(w);
      else if (w in NUM) {
        if (/^ein(e|en)?$/.test(w) && tokens[i + 1] && MULT.some(([re]) => re.test(tokens[i + 1]))) continue; // Artikel
        n = NUM[w];
      } else if (/und/.test(w)) {
        const parts = w.split('und');
        if (parts.length === 2 && parts[0] in NUM && parts[1] in NUM) n = NUM[parts[0]] + NUM[parts[1]];
      }
      if (n != null && num == null) num = n;
    }
    if (num == null) return null;
    if (num === 25) return { seg: 25, mult: mult === 2 ? 2 : 1 };
    if (num === 50) return { seg: 25, mult: 2 };
    if (num === 0) return { seg: 0, mult: 0 };
    if (num >= 1 && num <= 20) return { seg: num, mult: mult || 1, explicitMult: mult != null };
    return null;
  }

  function parseIndex(text) {
    const t = normalize(text);
    for (const w of t.split(' ')) {
      const o = ORD.find(([re]) => re.test(w));
      if (o) return { found: true, index: o[1] };
    }
    const m = t.match(/\bpfeil (eins|zwei|drei|1|2|3)\b/);
    if (m) return { found: true, index: { eins: 0, 1: 0, zwei: 1, 2: 1, drei: 2, 3: 2 }[m[1]] };
    return { found: false, index: null };
  }

  // Ein einzelner Befehl (ein Satzteil). verb: geerbtes Verb aus dem vorherigen Satzteil ("… und 13 auf 1")
  function parseOne(text, inherit) {
    const t = normalize(text);
    if (!t) return null;
    const verbCorrect = VERB_CORRECT.test(t) || (inherit === 'correct' && /\bauf\b/.test(t));
    const verbAdd = !verbCorrect && (VERB_ADD.test(t) || inherit === 'add');
    if (!verbCorrect && /\b(?:weiter|nächster|naechster|nächste|naechste|next|fertig)\b/.test(t)) return { type: 'next' };
    if (!verbCorrect && /\b(?:zurück|zurueck|rückgängig|rueckgaengig|undo|lösch\w*|loesch\w*)\b/.test(t)) return { type: 'undo' };
    const split = t.match(/^(.*?)\b(?:auf|zu|in|nach)\b(.*)$/);
    const left = (split ? split[1] : '').replace(VERB_CORRECT, ' ');
    const right = split ? split[2] : t;
    let field;
    if (split) field = parseField(right);
    else field = parseField(right.replace(VERB_CORRECT, ' ').replace(VERB_ADD, ' ').replace(/\b(?:erste[nrms]?|zweite[nrms]?|dritte[nrms]?|letzte[nrms]?|[123]\.)\b/g, ' ').replace(/\bpfeil\b(\s(?:eins|zwei|drei|1|2|3)\b)?/g, ' '));
    if (!field) return verbCorrect || verbAdd ? { type: 'unknown', text: t } : null;
    if (verbAdd) return { type: 'add', dart: field };
    // Welcher Pfeil? Ordnungszahl ("den zweiten") oder sein bisheriger Wert ("4", "Triple 20")
    const idx = parseIndex(left);
    let from = null;
    if (!idx.found) {
      const l = left.replace(/\b(?:den|dem|die|das|der|pfeil|bitte|mal|von|die)\b/g, ' ');
      from = parseField(l);
    }
    return { type: 'correct', index: idx.index, from, dart: field, explicitIndex: idx.found };
  }

  // Befehlstext (ohne Aktivierungswort) in einzelne Befehle zerlegen
  function parseCommands(text) {
    let t = normalize(text);
    if (!t) return [];
    // vor jedem weiteren Verb und an Satzzeichen/"und"/"dann" trennen
    t = t.replace(/\s(?=(?:korrigier|korigier|änder|aender)\w*\b)/g, ' | ').replace(/\s(?:und|dann|danach|sowie|und dann)\s/g, ' | ').replace(/(?<!\d)\.\s/g, ' | ');
    const out = [];
    let inherit = null;
    for (const part of t.split('|')) {
      const c = parseOne(part, inherit);
      if (!c) continue;
      if (c.type === 'correct') inherit = 'correct';
      else if (c.type === 'add') inherit = 'add';
      out.push(c);
    }
    return out;
  }
  const parseCommand = (text) => parseCommands(text)[0] || null;

  // Ganze Spracheingabe auswerten.
  // opts.direct: Korrektur-Befehle ("Korrigiere 4 auf 18") auch ohne Aktivierungswort annehmen
  function parse(text, opts = {}) {
    const t = normalize(text);
    const end = findWake(t);
    if (end >= 0) {
      const rest = t.slice(end).trim();
      const commands = parseCommands(rest);
      return { wake: true, direct: false, commands, command: commands[0] || null, rest };
    }
    if (opts.direct && VERB_DIRECT.test(t) && /\bauf\b/.test(t)) {
      const commands = parseCommands(t).filter((c) => c.type === 'correct');
      if (commands.length) return { wake: false, direct: true, commands, command: commands[0], rest: t };
    }
    return { wake: false, direct: false, commands: [], command: null, rest: t };
  }

  // Pfeil für "from" finden: zuerst exakt (Triple 20), dann nur die Zahl (4 = S4, D4 oder T4)
  function matchDart(darts, from, skip = []) {
    if (!from) return -1;
    const free = (i) => !skip.includes(i);
    const exact = darts.findIndex((d, i) => free(i) && d && d.seg === from.seg && (d.mult === from.mult || (!from.explicitMult && from.seg === 25)) && (from.explicitMult || from.seg === 25 || from.seg === 0 || d.mult === 1));
    if (exact >= 0) return exact;
    if (from.explicitMult) return -1;
    return darts.findIndex((d, i) => free(i) && d && d.seg === from.seg);
  }

  function label(d) {
    if (!d || !d.seg) return 'Daneben';
    if (d.seg === 25) return d.mult === 2 ? 'Bull' : 'Single Bull';
    return (d.mult === 3 ? 'Triple ' : d.mult === 2 ? 'Doppel ' : '') + d.seg;
  }

  return { parse, parseCommand, parseCommands, parseField, normalize, label, findWake, matchDart };
});
