// Geometrie einer Standard-Steeldartscheibe (Maße in mm) + Punkteberechnung + SVG
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Board = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Reihenfolge im Uhrzeigersinn, beginnend oben
  const ORDER = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
  const R = { bullIn: 6.35, bullOut: 15.9, trebleIn: 99, trebleOut: 107, doubleIn: 162, doubleOut: 170 };

  function dart(seg, mult) {
    return { seg, mult, value: seg * mult };
  }

  // x nach rechts, y nach unten, Ursprung = Bull
  function score(x, y) {
    const r = Math.hypot(x, y);
    if (r <= R.bullIn) return dart(25, 2);
    if (r <= R.bullOut) return dart(25, 1);
    if (r > R.doubleOut) return dart(0, 0);
    let deg = (Math.atan2(x, -y) * 180) / Math.PI;
    if (deg < 0) deg += 360;
    const seg = ORDER[Math.floor(((deg + 9) % 360) / 18)];
    let mult = 1;
    if (r >= R.trebleIn && r <= R.trebleOut) mult = 3;
    else if (r >= R.doubleIn) mult = 2;
    return dart(seg, mult);
  }

  function label(d) {
    if (!d || d.seg === 0) return 'Miss';
    if (d.seg === 25) return d.mult === 2 ? 'Bull' : '25';
    return (d.mult === 3 ? 'T' : d.mult === 2 ? 'D' : '') + d.seg;
  }

  function speech(d) {
    if (!d || d.seg === 0) return 'Daneben';
    if (d.seg === 25) return d.mult === 2 ? 'Bull' : 'fünfundzwanzig';
    if (d.mult === 3) return 'Triple ' + d.seg;
    if (d.mult === 2) return 'Double ' + d.seg;
    return String(d.seg);
  }

  function polar(r, deg) {
    const a = (deg * Math.PI) / 180;
    return [r * Math.sin(a), -r * Math.cos(a)];
  }

  // Ungefähre Position eines Treffers (für manuell eingegebene Pfeile)
  function position(d) {
    if (!d || d.seg === 0) return null;
    if (d.seg === 25) return d.mult === 2 ? [0, 0] : [0, -11];
    const idx = ORDER.indexOf(d.seg);
    const r = d.mult === 3 ? 103 : d.mult === 2 ? 166 : 135;
    return polar(r, idx * 18);
  }

  function arc(r1, r2, a1, a2) {
    const f = (p) => p[0].toFixed(2) + ' ' + p[1].toFixed(2);
    return `M${f(polar(r2, a1))}A${r2} ${r2} 0 0 1 ${f(polar(r2, a2))}L${f(polar(r1, a2))}A${r1} ${r1} 0 0 0 ${f(polar(r1, a1))}Z`;
  }

  function svg(extra = '') {
    const dark = '#1d1d1f', light = '#efe3c2', red = '#d33a2c', green = '#1f8a4c', wire = '#8c8f94';
    let s = `<svg viewBox="-200 -200 400 400" xmlns="http://www.w3.org/2000/svg" class="board-svg">`;
    s += `<circle r="199" fill="#101012"/>`;
    ORDER.forEach((n, i) => {
      const a1 = i * 18 - 9, a2 = i * 18 + 9;
      const base = i % 2 === 0 ? dark : light;
      const ring = i % 2 === 0 ? red : green;
      s += `<path d="${arc(R.doubleIn, R.doubleOut, a1, a2)}" fill="${ring}" stroke="${wire}" stroke-width=".6"/>`;
      s += `<path d="${arc(R.trebleOut, R.doubleIn, a1, a2)}" fill="${base}" stroke="${wire}" stroke-width=".6"/>`;
      s += `<path d="${arc(R.trebleIn, R.trebleOut, a1, a2)}" fill="${ring}" stroke="${wire}" stroke-width=".6"/>`;
      s += `<path d="${arc(R.bullOut, R.trebleIn, a1, a2)}" fill="${base}" stroke="${wire}" stroke-width=".6"/>`;
      const [tx, ty] = polar(185, i * 18);
      s += `<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" fill="#f4f4f4" font-size="17" font-weight="700" text-anchor="middle" dominant-baseline="central" font-family="system-ui,sans-serif">${n}</text>`;
    });
    s += `<circle r="${R.bullOut}" fill="${green}" stroke="${wire}" stroke-width=".6"/>`;
    s += `<circle r="${R.bullIn}" fill="${red}" stroke="${wire}" stroke-width=".6"/>`;
    s += extra + `</svg>`;
    return s;
  }

  return { ORDER, R, dart, score, label, speech, position, polar, svg };
});
