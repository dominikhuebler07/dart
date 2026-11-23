// Kleiner QR-Code-Erzeuger (Byte-Modus, Fehlerkorrektur M, Version 1–6, bis 106 Zeichen) – für den Koppel-Code am Bildschirm.
// Nach der Spezifikation ISO/IEC 18004. Läuft im Browser und in den Tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QR = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Fehlerkorrektur M: [EC-Bytes je Block, Blöcke Gruppe 1, Datenbytes G1, Blöcke G2, Datenbytes G2] für Version 1..10
  const EC_M = [null,
    [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0], [24, 2, 43, 0, 0],
    [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44]];
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

  // ---------- Galois-Feld GF(256) ----------
  const EXP = new Array(512), LOG = new Array(256);
  for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
  function rsGen(n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const ng = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= mul(g[j], EXP[i]); }
      g = ng;
    }
    return g;
  }
  function rsEc(data, n) {
    const gen = rsGen(n), res = new Array(n).fill(0);
    for (const d of data) {
      const f = d ^ res[0];
      res.shift(); res.push(0);
      for (let i = 0; i < n; i++) res[i] ^= mul(gen[i + 1], f);
    }
    return res;
  }

  function encode(text) {
    const bytes = Array.from(new TextEncoder().encode(String(text)));
    let ver = 1;
    for (; ver <= 6; ver++) {
      const e = EC_M[ver], cap = e[1] * e[2] + e[3] * e[4];
      const bits = 4 + (ver < 10 ? 8 : 16) + 8 * bytes.length;
      if (bits <= cap * 8) break;
    }
    if (ver > 6) throw new Error('Text zu lang für den QR-Code');
    const [ecLen, b1, d1, b2, d2] = EC_M[ver];
    const cap = b1 * d1 + b2 * d2;
    // Bitstrom: Modus 0100 (Byte), Länge, Daten, Abschluss, Füllbytes
    const bits = [];
    const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
    put(4, 4); put(bytes.length, ver < 10 ? 8 : 16);
    bytes.forEach((b) => put(b, 8));
    put(0, Math.min(4, cap * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
    for (let p = 0; data.length < cap; p++) data.push(p % 2 ? 0x11 : 0xec);
    // Blöcke + Fehlerkorrektur, verschränkt
    const blocks = [];
    let k = 0;
    for (let i = 0; i < b1 + b2; i++) { const len = i < b1 ? d1 : d2; const d = data.slice(k, k + len); k += len; blocks.push({ d, e: rsEc(d, ecLen) }); }
    const out = [];
    const maxD = Math.max(d1, d2);
    for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
    for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.e[i]);
    return place(ver, out);
  }

  function place(ver, codewords) {
    const n = ver * 4 + 17;
    const m = Array.from({ length: n }, () => new Array(n).fill(0));
    const fn = Array.from({ length: n }, () => new Array(n).fill(false)); // Funktionsmuster (nicht maskieren)
    const set = (x, y, v) => { m[y][x] = v ? 1 : 0; fn[y][x] = true; };
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
    };
    finder(3, 3); finder(n - 4, 3); finder(3, n - 4);
    for (let i = 0; i < n; i++) { if (!fn[6][i]) set(i, 6, i % 2 === 0); if (!fn[i][6]) set(6, i, i % 2 === 0); }
    const al = ALIGN[ver];
    for (const ay of al) for (const ax of al) {
      if (fn[ay][ax]) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    // Platz für Formatinfo reservieren + dunkles Modul
    for (let i = 0; i < 9; i++) { fn[8][i] = true; fn[i][8] = true; }
    for (let i = 0; i < 8; i++) { fn[8][n - 1 - i] = true; fn[n - 1 - i][8] = true; }
    set(8, n - 8, 1);
    // Daten im Zickzack einsetzen
    const bitsArr = [];
    codewords.forEach((c) => { for (let i = 7; i >= 0; i--) bitsArr.push((c >>> i) & 1); });
    let bi = 0;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < n; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j, up = ((right + 1) & 2) === 0, y = up ? n - 1 - vert : vert;
        if (fn[y][x]) continue;
        m[y][x] = bi < bitsArr.length ? bitsArr[bi++] : 0;
      }
    }
    // beste Maske wählen
    const MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
      (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0];
    let best = null, bestScore = Infinity;
    for (let mk = 0; mk < 8; mk++) {
      const t = m.map((r) => r.slice());
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (!fn[y][x] && MASKS[mk](x, y)) t[y][x] ^= 1;
      format(t, n, mk);
      const sc = penalty(t, n);
      if (sc < bestScore) { bestScore = sc; best = t; }
    }
    return best;
  }

  function format(t, n, mask) {
    const data = (0 << 3) | mask; // EC-Stufe M = 00
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const b = (i) => (bits >>> i) & 1;
    for (let i = 0; i <= 5; i++) t[i][8] = b(i);
    t[7][8] = b(6); t[8][8] = b(7); t[8][7] = b(8);
    for (let i = 9; i < 15; i++) t[8][14 - i] = b(i);
    for (let i = 0; i < 8; i++) t[8][n - 1 - i] = b(i);
    for (let i = 8; i < 15; i++) t[n - 15 + i][8] = b(i);
    t[n - 8][8] = 1;
  }

  function penalty(t, n) {
    let s = 0;
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < n; i++) {
      let run = 1;
      for (let j = 1; j < n; j++) {
        const a = pass ? t[j][i] : t[i][j], b = pass ? t[j - 1][i] : t[i][j - 1];
        if (a === b) { run++; if (run === 5) s += 3; else if (run > 5) s++; } else run = 1;
      }
    }
    for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) { const c = t[y][x]; if (c === t[y][x + 1] && c === t[y + 1][x] && c === t[y + 1][x + 1]) s += 3; }
    const pat = [1, 0, 1, 1, 1, 0, 1];
    for (let y = 0; y < n; y++) for (let x = 0; x + 7 <= n; x++) {
      let h = true, v = true;
      for (let k = 0; k < 7; k++) { if (t[y][x + k] !== pat[k]) h = false; if (t[x + k][y] !== pat[k]) v = false; }
      if (h) s += 40; if (v) s += 40;
    }
    let dark = 0; for (const r of t) for (const c of r) dark += c;
    s += Math.floor(Math.abs((dark * 20) / (n * n) - 10)) * 10;
    return s;
  }

  // Als SVG (mit Ruhezone)
  function svg(text, { dark = '#131518', light = '#fff' } = {}) {
    const m = encode(text), n = m.length, q = 4;
    let d = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) d += `M${x + q} ${y + q}h1v1h-1z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 2 * q} ${n + 2 * q}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
  }

  return { encode, svg };
});
