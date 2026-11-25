// Meldungen wegen Schummeln: als Nachricht aufs Handy (Telegram) und als Übersicht im Browser.
// Render-Umgebungsvariablen (alle freiwillig):
//   TELEGRAM_BOT_TOKEN  – Token deines Telegram-Bots (von @BotFather). Empfohlen: Nachricht + Bilder direkt aufs Handy.
//   TELEGRAM_CHAT_ID    – deine Chat-ID (Pflicht). Die Übersicht /admin/meldungen zeigt sie dir an, nachdem du dem Bot /start geschrieben hast.
//                         Aus Sicherheitsgründen wird NIE automatisch an einen gefundenen Chat gesendet (sonst könnte ein Fremder,
//                         der deinen Bot findet, deine Meldungen bekommen).
//   DISCORD_WEBHOOK_URL – alternativ: Nachricht in einen Discord-Kanal
//   BREVO_API_KEY, REPORT_TO, REPORT_FROM – alternativ: E-Mail über Brevo
//   ADMIN_KEY           – Passwort für die Übersicht /admin/meldungen?key=…
// Hinweis: Normale E-Mail (SMTP, z. B. Gmail) geht auf Render im Gratis-Plan nicht – Render sperrt diese Ports.
function createReports(opts = {}) {
  const env = (k) => (opts[k] != null ? opts[k] : process.env[k] || '');
  const TG_TOKEN = env('TELEGRAM_BOT_TOKEN');
  const tgChat = env('TELEGRAM_CHAT_ID');
  const DISCORD = env('DISCORD_WEBHOOK_URL');
  const BREVO = env('BREVO_API_KEY');
  const TO = env('REPORT_TO') || 'dart.scan.dh@gmail.com';
  const FROM = env('REPORT_FROM') || TO;
  const ADMIN = env('ADMIN_KEY');
  const fetchFn = opts.fetch || ((...a) => fetch(...a));
  const list = []; // letzte Meldungen (gehen bei einem Neustart verloren – die Nachricht bleibt)

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const kindName = { friends: 'Spiel mit Freunden', quick: 'Zufallsgegner', tourn: 'Turnier' };
  const jpeg = (f) => Buffer.from(String(f.img).split(',')[1] || '', 'base64');

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

  // kurzer Text für Telegram/Discord
  function text(r, tg) {
    const b = (s) => (tg ? `<b>${esc(s)}</b>` : `**${s}**`);
    const c = (s) => (tg ? `<code>${esc(s)}</code>` : '`' + s + '`');
    const t = (s) => (tg ? esc(s) : s);
    const lines = [
      `🚩 ${b('DartScan – Meldung')}`,
      `${t(r.reporter.name)} meldet ${b(r.target.name)}`,
      `Grund: ${b(r.reason || '–')}${r.text ? '\n„' + t(r.text) + '“' : ''}`,
      `${t(kindName[r.kind] || r.kind)} · Raum ${t(r.room)} · ${t(new Date(r.at).toLocaleString('de-AT', { timeZone: 'Europe/Vienna' }))}`,
      `Kamera des Gemeldeten aktiv: ${r.targetCam ? 'ja' : b('NEIN')} · ${r.frames.length} Bilder`,
      `Konto-ID (zum Sperren): ${c(r.target.uid || '–')}`,
      '',
      ...r.log.map((p) => `${b(p.name)} (Rest ${p.score}): ${t(p.turns.slice(-4).join(' | ') || '–')}`),
    ];
    return lines.join('\n').slice(0, tg ? 3900 : 1900);
  }

  // ---------- Telegram ----------
  async function tgCall(method, body, isForm) {
    const res = await fetchFn(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, isForm
      ? { method: 'POST', body }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) throw new Error('Telegram ' + method + ': ' + (j.description || res.status));
    return j.result;
  }
  // Wer hat dem Bot geschrieben? (nur zum Anzeigen in der Übersicht – gesendet wird nur an TELEGRAM_CHAT_ID)
  async function tgCandidates() {
    const ups = await tgCall('getUpdates', {});
    const seen = new Map();
    for (const u of ups) {
      const m = u.message || u.edited_message;
      if (m && m.chat && m.chat.type === 'private') seen.set(String(m.chat.id), [m.chat.first_name, m.chat.last_name, m.chat.username ? '@' + m.chat.username : ''].filter(Boolean).join(' '));
    }
    return [...seen.entries()];
  }
  async function telegram(r) {
    const chat = tgChat;
    if (!chat) throw new Error('TELEGRAM_CHAT_ID fehlt – in der Übersicht steht deine Chat-ID');
    await tgCall('sendMessage', { chat_id: chat, text: text(r, true), parse_mode: 'HTML', disable_web_page_preview: true });
    const frames = r.frames.slice(-6);
    if (frames.length === 1) {
      const fd = new FormData();
      fd.append('chat_id', chat);
      fd.append('caption', frames[0].dart ? 'Treffer ' + frames[0].dart : 'Kamerabild');
      fd.append('photo', new Blob([jpeg(frames[0])], { type: 'image/jpeg' }), 'bild.jpg');
      await tgCall('sendPhoto', fd, true);
    } else if (frames.length > 1) {
      const fd = new FormData();
      fd.append('chat_id', chat);
      fd.append('media', JSON.stringify(frames.map((f, i) => ({ type: 'photo', media: 'attach://p' + i, caption: `${new Date(f.ts).toLocaleTimeString('de-AT', { timeZone: 'Europe/Vienna' })}${f.dart ? ' · Treffer ' + f.dart : ''}` }))));
      frames.forEach((f, i) => fd.append('p' + i, new Blob([jpeg(f)], { type: 'image/jpeg' }), `bild${i + 1}.jpg`));
      await tgCall('sendMediaGroup', fd, true);
    }
  }

  // ---------- Discord ----------
  async function discord(r) {
    const fd = new FormData();
    const frames = r.frames.slice(-6);
    fd.append('payload_json', JSON.stringify({ content: text(r, false), attachments: frames.map((f, i) => ({ id: i, filename: `bild${i + 1}.jpg` })) }));
    frames.forEach((f, i) => fd.append(`files[${i}]`, new Blob([jpeg(f)], { type: 'image/jpeg' }), `bild${i + 1}.jpg`));
    const res = await fetchFn(DISCORD, { method: 'POST', body: fd });
    if (!res.ok) throw new Error('Discord ' + res.status);
  }

  // ---------- Brevo (E-Mail über HTTPS) ----------
  async function brevo(r) {
    const body = {
      sender: { email: FROM, name: 'DartScan Fair Play' },
      to: [{ email: TO }],
      subject: `DartScan Meldung: ${r.target.name} (${r.reason || 'ohne Grund'})`,
      htmlContent: html(r, false),
      attachment: r.frames.map((f, i) => ({ name: `bild-${i + 1}${f.dart ? '-' + f.dart.replace(/[^A-Za-z0-9]/g, '') : ''}.jpg`, content: f.img.split(',')[1] })),
    };
    const res = await fetchFn('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': BREVO, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error('Brevo ' + res.status + ' ' + (await res.text()).slice(0, 200));
  }

  const channels = () => [TG_TOKEN && ['Telegram', telegram], DISCORD && ['Discord', discord], BREVO && ['E-Mail', brevo]].filter(Boolean);

  async function notify(r) {
    const ch = channels();
    if (!ch.length) { console.log('[Meldung]', r.reporter.name, '->', r.target.name, '|', r.reason, '|', r.text, '| Bilder:', r.frames.length); return { sent: [], errors: [] }; }
    const sent = [], errors = [];
    for (const [name, fn] of ch) {
      try { await fn(r); sent.push(name); } catch (e) { errors.push(name + ': ' + e.message); console.error('Meldung nicht versendet –', name, e.message); }
    }
    return { sent, errors };
  }

  async function add(r) {
    list.unshift(r);
    if (list.length > 50) list.pop();
    const res = await notify(r);
    r.sent = res.sent; r.errors = res.errors;
    return res;
  }

  // Test-Meldung (Knopf in der Übersicht), um die Einrichtung zu prüfen
  function testReport() {
    return {
      id: 'test', at: new Date().toISOString(), room: 'TEST', kind: 'quick', tourn: null, reason: 'Test', text: 'Nur ein Test – die Benachrichtigung funktioniert!',
      reporter: { uid: 'test-melder', name: 'DartScan' }, target: { uid: 'test-konto', name: 'Testspieler' }, targetCam: true, log: [], frames: [],
    };
  }

  async function page(req, res) {
    if (!ADMIN || req.query.key !== ADMIN) return res.status(403).send('Kein Zugriff. ADMIN_KEY auf Render setzen und ?key=… anhängen.');
    let note = '';
    if (req.query.test) {
      const r = await notify(testReport());
      note = r.sent.length ? `<p style="color:green"><b>Test-Nachricht gesendet über: ${esc(r.sent.join(', '))}</b></p>` : '';
      if (r.errors.length) note += `<p style="color:#c00"><b>Fehler:</b> ${esc(r.errors.join(' · '))}</p>`;
      if (!r.sent.length && !r.errors.length) note = '<p style="color:#c00"><b>Kein Benachrichtigungs-Weg eingerichtet</b> (z. B. TELEGRAM_BOT_TOKEN).</p>';
    }
    const ch = channels().map((c) => c[0]);
    if (TG_TOKEN && !tgChat) {
      let who = '';
      try {
        const c = await tgCandidates();
        who = c.length ? '<ul>' + c.map(([id, n]) => `<li>${esc(n || 'ohne Namen')}: <code style="font-size:1.2em">${esc(id)}</code></li>`).join('') + '</ul>' : '<p>Noch niemand gefunden. Öffne deinen Bot in Telegram, tippe auf <b>Start</b> und lade diese Seite neu.</p>';
      } catch (e) { who = `<p style="color:#c00">${esc(e.message)}</p>`; }
      note += `<div style="border:2px solid #d8b04a;border-radius:8px;padding:8px 14px"><p><b>Noch ein Schritt:</b> Trag deine Chat-ID auf Render als <code>TELEGRAM_CHAT_ID</code> ein. Nimm nur die Zeile mit <b>deinem</b> Namen:</p>${who}</div>`;
    }
    res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DartScan Meldungen</title>
<body style="font-family:system-ui;max-width:900px;margin:auto;padding:16px">
<h1>Meldungen (${list.length})</h1>
<p>Benachrichtigung: <b>${ch.length ? esc(ch.join(', ')) : 'keine eingerichtet'}</b> · <a href="?key=${encodeURIComponent(req.query.key)}&test=1">Test-Nachricht senden</a></p>${note}
<p style="color:#666">Hier stehen nur Meldungen seit dem letzten Server-Neustart. Die Nachrichten aufs Handy bleiben.</p>
${list.map((r) => `<section style="border:1px solid #ccc;border-radius:8px;padding:8px 14px;margin:12px 0">${html(r, true)}<p>Gesendet: ${r.sent && r.sent.length ? esc(r.sent.join(', ')) : 'nein'}${r.errors && r.errors.length ? ' · Fehler: ' + esc(r.errors.join(' · ')) : ''}</p></section>`).join('') || '<p>Keine Meldungen.</p>'}
</body>`);
  }

  return { add, page, list, html, text, notify };
}

module.exports = { createReports };
