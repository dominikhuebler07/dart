// Meldungen wegen Schummeln: per E-Mail an dich (Brevo) und als Übersicht im Browser.
// Render-Umgebungsvariablen:
//   BREVO_API_KEY  – API-Schlüssel aus Brevo (SMTP & API → API-Schlüssel)
//   REPORT_TO      – deine Adresse (Standard: dart.scan.dh@gmail.com)
//   REPORT_FROM    – Absender, muss in Brevo als Absender bestätigt sein (Standard: wie REPORT_TO)
//   ADMIN_KEY      – Passwort für die Übersicht /admin/meldungen?key=…
// Ohne BREVO_API_KEY wird nur ins Server-Log geschrieben und die Übersicht gefüllt.
function createReports(opts = {}) {
  const KEY = opts.apiKey != null ? opts.apiKey : process.env.BREVO_API_KEY || '';
  const TO = opts.to || process.env.REPORT_TO || 'dart.scan.dh@gmail.com';
  const FROM = opts.from || process.env.REPORT_FROM || TO;
  const ADMIN = opts.adminKey != null ? opts.adminKey : process.env.ADMIN_KEY || '';
  const fetchFn = opts.fetch || ((...a) => fetch(...a));
  const list = []; // letzte Meldungen (gehen bei einem Neustart verloren – die E-Mail bleibt)

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const kindName = { friends: 'Spiel mit Freunden', quick: 'Zufallsgegner', tourn: 'Turnier' };

  function html(r, withImages) {
    return `<h2>DartScan – Meldung</h2>
<p><b>${esc(r.reporter.name)}</b> meldet <b>${esc(r.target.name)}</b> (Konto-ID: <code>${esc(r.target.uid || '–')}</code>)</p>
<p>Grund: <b>${esc(r.reason || '–')}</b>${r.text ? `<br>Text: ${esc(r.text)}` : ''}</p>
<p>${esc(kindName[r.kind] || r.kind)} · Raum ${esc(r.room)}${r.tourn ? ' · Turnier ' + esc(r.tourn) : ''} · ${esc(r.at)}<br>
Kamera des Gemeldeten zuletzt aktiv: <b>${r.targetCam ? 'ja' : 'NEIN'}</b> · Melder-Konto: <code>${esc(r.reporter.uid)}</code></p>
<h3>Spielverlauf (letzte Aufnahmen)</h3>
${r.log.map((p) => `<p><b>${esc(p.name)}</b> (Rest ${p.score})<br>${p.turns.map(esc).join('<br>') || '–'}</p>`).join('')}
<h3>Kamerabilder des Gemeldeten (${r.frames.length})</h3>
${withImages ? r.frames.map((f) => `<figure style="display:inline-block;margin:4px"><img src="${f.img}" style="max-width:320px;border:1px solid #888"><figcaption>${esc(new Date(f.ts).toLocaleTimeString('de-AT'))}${f.dart ? ' · Treffer ' + esc(f.dart) : ''}</figcaption></figure>`).join('') : '<p>Siehe Anhänge.</p>'}
<p style="color:#888">Sperren: Konto-ID in der Render-Umgebungsvariable BANNED_UIDS eintragen (mehrere mit Komma trennen).</p>`;
  }

  async function mail(r) {
    if (!KEY) { console.log('[Meldung]', r.reporter.name, '->', r.target.name, '|', r.reason, '|', r.text, '| Bilder:', r.frames.length); return { sent: false }; }
    const body = {
      sender: { email: FROM, name: 'DartScan Fair Play' },
      to: [{ email: TO }],
      subject: `DartScan Meldung: ${r.target.name} (${r.reason || 'ohne Grund'})`,
      htmlContent: html(r, false),
      attachment: r.frames.map((f, i) => ({ name: `bild-${i + 1}${f.dart ? '-' + f.dart.replace(/[^A-Za-z0-9]/g, '') : ''}.jpg`, content: f.img.split(',')[1] })),
    };
    try {
      const res = await fetchFn('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': KEY, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) { console.error('Brevo-Fehler', res.status, (await res.text()).slice(0, 300)); return { sent: false }; }
      return { sent: true };
    } catch (e) { console.error('Meldung nicht versendet:', e.message); return { sent: false }; }
  }

  async function add(r) {
    list.unshift(r);
    if (list.length > 50) list.pop();
    const res = await mail(r);
    r.mailed = res.sent;
    return res;
  }

  function page(req, res) {
    if (!ADMIN || req.query.key !== ADMIN) return res.status(403).send('Kein Zugriff. ADMIN_KEY auf Render setzen und ?key=… anhängen.');
    res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DartScan Meldungen</title>
<body style="font-family:system-ui;max-width:900px;margin:auto;padding:16px">
<h1>Meldungen (${list.length})</h1><p>Nur seit dem letzten Server-Neustart. Alle Meldungen bekommst du zusätzlich per E-Mail${KEY ? '' : ' (Brevo noch nicht eingerichtet!)'}.</p>
${list.map((r) => `<section style="border:1px solid #ccc;border-radius:8px;padding:8px 14px;margin:12px 0">${html(r, true)}<p>E-Mail: ${r.mailed ? 'versendet' : 'nicht versendet'}</p></section>`).join('') || '<p>Keine Meldungen.</p>'}
</body>`);
  }

  return { add, page, list, html };
}

module.exports = { createReports };
