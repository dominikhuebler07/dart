// Scroll-Streifen am rechten Rand: Hier wischt man ganz normal hoch und runter (wie überall auf der Seite),
// ohne das Kamerabild zu berühren – beim Kalibrieren oder im gezoomten Bild würde ein Wisch dort sonst etwas verschieben.
// Bewusst einfach: kein eigenes Scrollen per Skript, der Browser scrollt selbst (mit Schwung, flüssig).
(() => {
  'use strict';
  const strip = document.createElement('div');
  strip.className = 'sstrip hidden';
  strip.setAttribute('aria-hidden', 'true');
  strip.innerHTML = '<div class="sstrip-line"><div class="sstrip-thumb"></div></div><div class="sstrip-grip"><span></span><span></span><span></span></div>';
  document.body.appendChild(strip);
  const line = strip.querySelector('.sstrip-line');
  const thumb = strip.querySelector('.sstrip-thumb');
  const doc = document.scrollingElement || document.documentElement;
  const maxScroll = () => Math.max(0, doc.scrollHeight - window.innerHeight);

  let raf = 0;
  function layout() {
    raf = 0;
    const panel = document.getElementById('cam-panel');
    const camVisible = panel && !panel.classList.contains('hidden') && panel.offsetParent !== null;
    const show = camVisible && maxScroll() > 40;
    strip.classList.toggle('hidden', !show);
    document.body.classList.toggle('rail-on', show);
    if (!show) return;
    const th = line.clientHeight;
    const h = Math.max(36, th * Math.min(1, window.innerHeight / doc.scrollHeight));
    thumb.style.height = h + 'px';
    thumb.style.transform = `translateY(${(th - h) * (maxScroll() ? window.scrollY / maxScroll() : 0)}px)`;
  }
  const soon = () => { if (!raf) raf = requestAnimationFrame(layout); };
  window.addEventListener('scroll', soon, { passive: true });
  window.addEventListener('resize', soon);
  setInterval(soon, 700);

  // Mit der Maus (Laptop) kann man den Streifen ziehen; am Handy scrollt der Browser beim Wischen von selbst.
  let drag = null;
  strip.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') return;
    e.preventDefault();
    drag = { y: e.clientY, s: window.scrollY };
    strip.setPointerCapture(e.pointerId);
  });
  strip.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = line.getBoundingClientRect();
    window.scrollTo(0, drag.s + ((e.clientY - drag.y) / Math.max(1, r.height)) * doc.scrollHeight);
  });
  const end = () => { drag = null; };
  strip.addEventListener('pointerup', end); strip.addEventListener('pointercancel', end);
  layout();
})();
