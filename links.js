// Geräte koppeln (unabhängig vom Transport, damit testbar):
//  - Bildschirm (Fernseher/Laptop) zeigt Spielstand und Kamerabild des Handys
//  - Zweites Handy als zweite Kamera (links/rechts) für genauere Treffer
// Ablauf: Das Zusatzgerät holt sich einen Code (linknew), das Haupt-Handy gibt ihn ein (linkjoin).
const crypto = require('crypto');

function createLinks(opts = {}) {
  const now = opts.now || (() => Date.now());
  const CODE_TTL = opts.codeTtl || 15 * 60e3;
  const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  /** @type {Map<string, any>} Code -> Kopplung */
  const links = new Map();
  const byToken = new Map();   // Geräte-Token -> Kopplung
  const ctlTokens = new Map(); // Handy-Token -> Set(Kopplungen) – ein Handy kann mehrere Geräte steuern

  const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
  function newCode() {
    let c;
    do c = Array.from({ length: 5 }, () => CHARS[crypto.randomInt(CHARS.length)]).join(''); while (links.has(c));
    return c;
  }
  const token = () => crypto.randomBytes(12).toString('hex');

  // alle Geräte, die an diesem Haupt-Handy hängen
  function devicesOf(ctl, role) {
    const out = [];
    for (const L of links.values()) if (L.ctl === ctl && L.device && (!role || L.role === role)) out.push(L);
    return out;
  }
  function info(L) { return { code: L.code, role: L.role, name: L.name, online: !!(L.device && L.device.readyState === 1) }; }
  function tellCtl(ctl) {
    if (!ctl) return;
    send(ctl, { t: 'links', devices: devicesOf(ctl).map(info) });
  }

  function handle(ws, m) {
    switch (m.t) {
      case 'linknew': { // Zusatzgerät: Bildschirm oder 2. Kamera
        const role = m.role === 'cam2' ? 'cam2' : 'display';
        drop(ws);
        const L = { code: newCode(), role, device: ws, ctl: null, created: now(), token: token(), ctlToken: null, name: String(m.name || '').slice(0, 24) };
        links.set(L.code, L);
        byToken.set(L.token, L);
        ws.link = L;
        return send(ws, { t: 'linkcode', code: L.code, role, token: L.token });
      }
      case 'linkresume': { // nach Verbindungsabbruch (Gerät oder Haupt-Handy)
        const tk = String(m.token || '');
        const L = byToken.get(tk);
        if (L) {
          L.device = ws; ws.link = L;
          send(ws, { t: L.ctl ? 'linked' : 'linkcode', code: L.code, role: L.role, token: L.token });
          if (L.ctl) { tellCtl(L.ctl); if (L.last) send(ws, L.last); }
          return;
        }
        const set = ctlTokens.get(tk);
        if (!set || !set.size) return send(ws, { t: 'linkgone' });
        ws.ctlToken = tk;
        for (const K of set) {
          K.ctl = ws;
          (ws.ctlLinks || (ws.ctlLinks = new Set())).add(K);
          send(K.device, { t: 'linked', code: K.code, role: K.role, token: K.token });
        }
        send(ws, { t: 'linkok', ctlToken: tk, resumed: true });
        return tellCtl(ws);
      }
      case 'linkjoin': { // Haupt-Handy gibt den Code ein
        const L = links.get(String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''));
        if (!L || !L.device) return send(ws, { t: 'error', msg: 'Code nicht gefunden. Steht er noch am anderen Gerät?' });
        if (L.ctl && L.ctl !== ws && L.ctl.readyState === 1) return send(ws, { t: 'error', msg: 'Dieses Gerät ist schon mit einem anderen Handy gekoppelt.' });
        if (L.device === ws) return send(ws, { t: 'error', msg: 'Das ist dieses Gerät selbst.' });
        L.ctl = ws;
        ws.ctlToken = ws.ctlToken || token();
        L.ctlToken = ws.ctlToken;
        if (!ctlTokens.has(L.ctlToken)) ctlTokens.set(L.ctlToken, new Set());
        ctlTokens.get(L.ctlToken).add(L);
        (ws.ctlLinks || (ws.ctlLinks = new Set())).add(L);
        send(ws, { t: 'linkok', code: L.code, role: L.role, ctlToken: L.ctlToken });
        send(L.device, { t: 'linked', code: L.code, role: L.role, token: L.token });
        return tellCtl(ws);
      }
      case 'unlink': {
        if (m.code) { // Haupt-Handy trennt ein Gerät
          const L = links.get(String(m.code));
          if (L && L.ctl === ws) { send(L.device, { t: 'unlinked' }); remove(L); tellCtl(ws); }
          return;
        }
        if (ws.link) { const ctl = ws.link.ctl; remove(ws.link); tellCtl(ctl); }
        return;
      }
      case 'show': { // Haupt-Handy -> Bildschirme: aktueller Spielstand
        const msg = { t: 'show', state: m.state };
        for (const L of devicesOf(ws, 'display')) { L.last = msg; send(L.device, msg); }
        return;
      }
      case 'dispcmd': { // Bildschirm (Laptop) -> Haupt-Handy: Wurf korrigieren/eintragen, weiter, zurück
        const L = ws.link;
        if (!L || L.role !== 'display' || !L.ctl) return;
        const c = m.cmd || {};
        const kind = ['correct', 'add', 'remove', 'next', 'undo'].includes(c.kind) ? c.kind : null;
        if (!kind) return;
        const seg = Number(c.dart && c.dart.seg), mult = Number(c.dart && c.dart.mult);
        const dart = (seg === 0 && mult === 0) || (seg >= 1 && seg <= 20 && mult >= 1 && mult <= 3) || (seg === 25 && (mult === 1 || mult === 2)) ? { seg, mult } : null;
        if ((kind === 'correct' || kind === 'add') && !dart) return;
        const index = Number.isInteger(c.index) && c.index >= 0 && c.index < 3 ? c.index : null;
        send(L.ctl, { t: 'dispcmd', code: L.code, cmd: { kind, dart, index, which: c.which === 'last' ? 'last' : 'cur' } });
        return;
      }
      case 'cam2ctl': { // Haupt-Handy -> 2. Kamera: Aufnahme beginnt / Pfeile ziehen / Pause
        for (const L of devicesOf(ws, 'cam2')) send(L.device, { t: 'cam2ctl', phase: m.phase, key: m.key });
        return;
      }
      case 'cam2dart': { // 2. Kamera -> Haupt-Handy: erkannter Pfeil
        const L = ws.link;
        if (L && L.role === 'cam2' && L.ctl) send(L.ctl, { t: 'cam2dart', code: L.code, dart: m.dart, key: m.key, q: m.q, ts: now() });
        return;
      }
      case 'cam2state': { // 2. Kamera -> Haupt-Handy: bereit / Scheibe verloren
        const L = ws.link;
        if (L && L.role === 'cam2' && L.ctl) send(L.ctl, { t: 'cam2state', code: L.code, ready: !!m.ready, q: m.q });
        return;
      }
    }
  }
  const TYPES = new Set(['linknew', 'linkresume', 'linkjoin', 'unlink', 'show', 'dispcmd', 'cam2ctl', 'cam2dart', 'cam2state']);

  // Kamerabild des Haupt-Handys an seine Bildschirme
  function relay(ws, msg) {
    if (!ws.ctlLinks) return;
    for (const L of ws.ctlLinks) if (L.ctl === ws && L.role === 'display') send(L.device, msg);
  }

  function remove(L) {
    links.delete(L.code);
    byToken.delete(L.token);
    if (L.ctlToken && ctlTokens.has(L.ctlToken)) { ctlTokens.get(L.ctlToken).delete(L); if (!ctlTokens.get(L.ctlToken).size) ctlTokens.delete(L.ctlToken); }
    if (L.ctl && L.ctl.ctlLinks) L.ctl.ctlLinks.delete(L);
    if (L.device && L.device.link === L) L.device.link = null;
  }
  // Gerät bekommt einen neuen Code: alte, noch nicht gekoppelte Codes dieses Geräts verwerfen
  function drop(ws) { if (ws.link && !ws.link.ctl) remove(ws.link); }

  // Verbindung weg: Kopplung bleibt (für Wiederverbinden), Gegenstelle informieren
  function detach(ws) {
    if (ws.link && ws.link.device === ws) tellCtl(ws.link.ctl);
    if (ws.ctlLinks) for (const L of ws.ctlLinks) if (L.ctl === ws) send(L.device, { t: 'ctloffline' });
  }

  function sweep() {
    const t = now();
    for (const L of [...links.values()]) {
      const devGone = !L.device || L.device.readyState !== 1;
      const ctlGone = !L.ctl || L.ctl.readyState !== 1;
      if (!L.ctl && t - L.created > CODE_TTL) remove(L);
      else if (devGone && ctlGone && t - (L.goneSince || (L.goneSince = t)) > 30 * 60e3) remove(L);
      else if (!(devGone && ctlGone)) L.goneSince = 0;
    }
  }

  return { links, handle, relay, detach, sweep, TYPES };
}

module.exports = { createLinks };
