// Dartcoins: 1 Runde = 1 Coin. In der Testphase sind die Coins unbegrenzt (UNLIMITED = true).
// Später: UNLIMITED auf false setzen und earnByVideo() mit dem Werbepartner (Rewarded Ad) verbinden.
(() => {
  'use strict';
  const UNLIMITED = true;
  const KEY = 'ds.coins';
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch (_) { return null; } };
  const state = Object.assign({ balance: 0, played: 0, log: [] }, load() || {});
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} };
  const listeners = [];
  const changed = () => { save(); listeners.forEach((fn) => { try { fn(); } catch (_) {} }); };

  const ICON = `<svg class="coin-ic" viewBox="-10 -10 20 20" aria-hidden="true"><circle r="9.4" fill="#d8b04a" stroke="#8a6418" stroke-width="1.2"/><circle r="6.6" fill="#e8c25a" stroke="#a37a22" stroke-width=".8"/><circle r="4.2" fill="none" stroke="#8a6418" stroke-width="1.1"/><circle r="1.6" fill="#e5322b"/></svg>`;

  function log(type, n, reason) {
    state.log.push({ t: Date.now(), type, n, reason });
    if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
  }

  const Coins = {
    ICON,
    get unlimited() { return UNLIMITED; },
    get balance() { return UNLIMITED ? Infinity : state.balance; },
    get played() { return state.played; },
    label() { return UNLIMITED ? '∞' : String(state.balance); },
    // Eine Runde spielen. Gibt false zurück, wenn nicht genug Coins da sind.
    spend(n = 1, reason = 'runde') {
      if (!UNLIMITED && state.balance < n) return false;
      if (!UNLIMITED) state.balance -= n;
      state.played += n;
      log('spend', n, reason);
      changed();
      return true;
    },
    earn(n, reason = 'bonus') {
      if (!(n > 0)) return;
      state.balance += n;
      log('earn', n, reason);
      changed();
    },
    // Platzhalter für das Werbevideo des Partners (Rewarded Ad): 1 Video = 1 Coin
    async earnByVideo() {
      if (UNLIMITED) return true;
      return false;
    },
    onChange(fn) { listeners.push(fn); },
  };
  window.Coins = Coins;
})();
