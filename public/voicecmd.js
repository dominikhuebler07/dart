// Sprachbefehle erkennen: "Dartcounter, korrigiere auf Triple 20", "… den zweiten Pfeil auf Doppel 16",
// "… weiter", "… zurück", "… Miss". Läuft im Browser und in den Tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VoiceCmd = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Aktivierungswort, tolerant gegenüber Hörfehlern der Spracherkennung
  const WAKE = /\b(?:dart|darts|dard|dat|tart|dirt)\s*-?\s*(?:counter|counters|kaunter|caunter|counta|conter|county|count|kounter|scan|skan)\b|\bdartcounter\b|\bdartscan\b/;

  const NUM = {
    null: 0, eins: 1, ein: 1, eine: 1, einen: 1, zwei: 2, zwo: 2, drei: 3, vier: 4, fünf: 5, fuenf: 5, sechs: 6, sieben: 7,
    acht: 8, neun: 9, zehn: 10, elf: 11, zwölf: 12, zwoelf: 12, dreizehn: 13, vierzehn: 14, fünfzehn: 15, fuenfzehn: 15,
    sechzehn: 16, siebzehn: 17, achtzehn: 18, neunzehn: 19, zwanzig: 20, fünfundzwanzig: 25, fuenfundzwanzig: 25, fünfzig: 50, fuenfzig: 50,
  };
  const MULT = [
    [/^(?:triple|tripel|tripple|trippel|treble|triebel|tribble|dreifach|dreifache[nrs]?|t)$/, 3],
    [/^(?:double|doppel|doppelt|doppelte[nrs]?|dobble|dabble|dubble|d)$/, 2],
    [/^(?:single|einfach|einfache[nrs]?|einzel|einzelne[nrs]?|s)$/, 1],
  ];
  const ORD = [
    [/^(?:erste[nrms]?|1\.)$/, 0],
    [/^(?:zweite[nrms]?|2\.)$/, 1],
    [/^(?:dritte[nrms]?|3\.)$/, 2],
    [/^(?:letzte[nrms]?)$/, null],
  ];

  function normalize(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/ß/g, 'ss')
      .replace(/(\d)\.(?=\s|$)/g, '$1. ') // Ordnungszahlen "2." erhalten
      .replace(/[^\p{L}\d. ]+/gu, ' ')
      .replace(/\b([tds])\s?-?(\d{1,2})\b/g, '$1 $2') // "T20" -> "t 20"
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Feld aus Text, z. B. "triple 20", "doppel sechzehn", "bull", "daneben" -> {seg, mult} oder null
  function parseField(text) {
    const t = normalize(text);
    if (!t) return null;
    if (/\b(?:miss|mis|daneben|vorbei|nichts|kein treffer|null|0)\b/.test(t)) return { seg: 0, mult: 0 };
    if (/\b(?:bull|bulls|bullseye|bullauge|bullen|boll)\b/.test(t)) {
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
        // "ein triple 20": "ein" ist hier ein Artikel, keine Zahl
        if (/^ein(e|en)?$/.test(w) && tokens[i + 1] && MULT.some(([re]) => re.test(tokens[i + 1]))) continue;
        n = NUM[w];
      } else if (/und/.test(w)) {
        // zusammengesetzte Zahlwörter, die oben fehlen
        const parts = w.split('und');
        if (parts.length === 2 && parts[0] in NUM && parts[1] in NUM) n = NUM[parts[0]] + NUM[parts[1]];
      }
      if (n != null && num == null) num = n;
    }
    if (num == null) return null;
    if (num === 25) return { seg: 25, mult: mult === 2 ? 2 : 1 };
    if (num === 50) return { seg: 25, mult: 2 };
    if (num === 0) return { seg: 0, mult: 0 };
    if (num >= 1 && num <= 20) return { seg: num, mult: mult || 1 };
    return null;
  }

  function parseIndex(text) {
    for (const w of normalize(text).split(' ')) {
      const o = ORD.find(([re]) => re.test(w));
      if (o) return { found: true, index: o[1] };
    }
    const m = normalize(text).match(/\bpfeil (eins|zwei|drei|1|2|3)\b/);
    if (m) return { found: true, index: { eins: 0, 1: 0, zwei: 1, 2: 1, drei: 2, 3: 2 }[m[1]] };
    return { found: false, index: null };
  }

  // Befehl ohne Aktivierungswort auswerten (Text NACH "Dartcounter")
  function parseCommand(text) {
    const t = normalize(text);
    if (!t) return null;
    const verbCorrect = /\b(?:korrigier\w*|korrektur|änder\w*|aender\w*|setz\w*|stell\w*|mach\w*|ersetz\w*|falsch)\b/.test(t);
    const verbAdd = /\b(?:eintrag\w*|trag\w*|hinzu\w*|notier\w*|zähl\w*|zaehl\w*)\b/.test(t);
    if (!verbCorrect && /\b(?:weiter|nächster|naechster|nächste|naechste|next|fertig)\b/.test(t)) return { type: 'next' };
    if (!verbCorrect && /\b(?:zurück|zurueck|rückgängig|rueckgaengig|undo|lösch\w*|loesch\w*)\b/.test(t)) return { type: 'undo' };
    // "… den zweiten Pfeil auf Triple 20": links von "auf"/"zu" steht der Pfeil, rechts das neue Feld
    const split = t.match(/^(.*?)\b(?:auf|zu|in|nach)\b(.*)$/);
    const left = split ? split[1] : t, right = split ? split[2] : t;
    const idx = parseIndex(left);
    let fieldText = right;
    if (!split) fieldText = right.replace(/\b(?:erste[nrms]?|zweite[nrms]?|dritte[nrms]?|letzte[nrms]?|[123]\.)\b/g, ' ');
    fieldText = fieldText.replace(/\bpfeil\b(\s(?:eins|zwei|drei|1|2|3)\b)?/g, ' ');
    const field = parseField(fieldText);
    if (!field) return verbCorrect || verbAdd ? { type: 'unknown', text: t } : null;
    if (verbAdd && !verbCorrect) return { type: 'add', dart: field };
    return { type: 'correct', index: idx.index, dart: field, explicitIndex: idx.found };
  }

  // Ganze Spracheingabe auswerten: { wake: bool, command: {…} | null, rest }
  function parse(text) {
    const t = normalize(text);
    const m = t.match(WAKE);
    if (!m) return { wake: false, command: null, rest: t };
    const rest = t.slice(m.index + m[0].length).trim();
    return { wake: true, command: parseCommand(rest), rest };
  }

  function label(d) {
    if (!d || !d.seg) return 'Daneben';
    if (d.seg === 25) return d.mult === 2 ? 'Bull' : 'Single Bull';
    return (d.mult === 3 ? 'Triple ' : d.mult === 2 ? 'Doppel ' : '') + d.seg;
  }

  return { parse, parseCommand, parseField, normalize, label, WAKE };
});
