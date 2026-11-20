// Scroll-Leiste am rechten Rand: Seite scrollen, ohne das Kamerabild zu berühren
// (beim Kalibrieren würde ein Wisch über das Bild sonst einen Punkt setzen).
(() => {
  'use strict';
  const rail = document.createElement('div');
  rail.className = 'srail hidden';
  rail.setAttribute('aria-hidden', 'true');
  rail.innerHTML = `
    <button type="button" class="srail-btn" data-d="-1" tabindex="-1"><svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg></button>
    <div class="srail-track"><div class="srail-thumb"><span></span><span></span><span></span></div></div>
    <button type="button" class="srail-btn" data-d="1" tabindex="-1"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>`;
  document.body.appendChild(rail);
  const track = rail.querySelector('.srail-track');
  const thumb = rail.querySelector('.srail-thumb');
  const doc = document.scrollingElement || document.documentElement;

  const maxScroll = () => Math.max(0, doc.scrollHeight - window.innerHeight);
  function layout() {
    const panel = document.getElementById('cam-panel');
    const camVisible = panel && !panel.classList.contains('hidden') && panel.offsetParent !== null;
    const show = camVisible && maxScroll() > 40;
    rail.classList.toggle('hidden', !show);
    document.body.classList.toggle('rail-on', show);
    if (!show) return;
    const th = track.clientHeight;
    const ratio = Math.min(1, window.innerHeight / doc.scrollHeight);
    const h = Math.max(44, th * ratio);
    thumb.style.height = h + 'px';
    thumb.style.transform = `translateY(${(th - h) * (maxScroll() ? window.scrollY / maxScroll() : 0)}px)`;
  }
  window.addEventListener('scroll', layout, { passive: true });
  window.addEventListener('resize', layout);
  setInterval(layout, 600);

  // Pfeiltasten: ein gutes Stück scrollen; gedrückt halten = weiter scrollen
  let holdT = null;
  const step = (d) => window.scrollBy({ top: d * window.innerHeight * 0.45, behavior: 'smooth' });
  rail.querySelectorAll('.srail-btn').forEach((b) => {
    const d = Number(b.dataset.d);
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      step(d);
      clearInterval(holdT); clearTimeout(holdT);
      holdT = setTimeout(() => { holdT = setInterval(() => window.scrollBy({ top: d * 18 }), 30); }, 380);
    });
    const stop = () => { clearTimeout(holdT); clearInterval(holdT); };
    b.addEventListener('pointerup', stop); b.addEventListener('pointercancel', stop); b.addEventListener('pointerleave', stop);
  });

  // Griff ziehen oder in die Leiste tippen
  let drag = null;
  function scrollToY(clientY, grabOffset) {
    const r = track.getBoundingClientRect();
    const h = thumb.offsetHeight;
    const p = Math.min(1, Math.max(0, (clientY - r.top - grabOffset) / Math.max(1, r.height - h)));
    window.scrollTo(0, p * maxScroll());
  }
  track.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    const tr = thumb.getBoundingClientRect();
    const onThumb = e.clientY >= tr.top && e.clientY <= tr.bottom;
    drag = { off: onThumb ? e.clientY - tr.top : thumb.offsetHeight / 2 };
    track.setPointerCapture(e.pointerId);
    rail.classList.add('active');
    scrollToY(e.clientY, drag.off);
  });
  track.addEventListener('pointermove', (e) => { if (drag) scrollToY(e.clientY, drag.off); });
  const end = () => { drag = null; rail.classList.remove('active'); };
  track.addEventListener('pointerup', end); track.addEventListener('pointercancel', end);
  layout();
})();
