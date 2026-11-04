// Telão — roda em cada página (e em cada player dentro dela). Acha o vídeo principal, conta para o Telão
// como ele está (tocando, pausado, em que ponto) e obedece tocar/pausar/pular. Não lê nada além do vídeo.
(() => {
  if (window.__telaoExt) return;
  window.__telaoExt = true;
  const isTop = window === window.top;
  // a Netflix quebra se mudarem a posição do vídeo por fora: lá só tocar/pausar
  const noSeek = /(^|\.)netflix\.com$/i.test(location.hostname);
  let port = null;

  function connect() {
    try {
      port = chrome.runtime.connect({ name: 'telao' });
      port.onDisconnect.addListener(() => { port = null; });
    } catch { port = null; }
  }
  const post = (m) => { if (!port) connect(); try { port && port.postMessage(m); } catch { port = null; } };

  function best() {
    let b = null, score = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      const area = Math.max(0, r.width) * Math.max(0, r.height);
      if (area < 120 * 70 && !(v.duration > 60)) continue; // anúncio/prévia pequena
      const s = area * (v.readyState > 0 ? 1 : 0.2) + (v.paused ? 0 : 1e7) + (v.duration > 300 ? 5e6 : 0);
      if (s > score) { score = s; b = v; }
    }
    return b ? { v: b, score } : null;
  }

  let ticks = 0;
  setInterval(() => {
    ticks++;
    const f = best();
    if (f) {
      window.__telaoV = f.v;
      const d = f.v.duration;
      post({ t: 'video', score: f.score, top: isTop ? location.href : null, title: isTop ? document.title : null, noSeek,
        state: { time: f.v.currentTime || 0, dur: isFinite(d) ? d : 0, live: d === Infinity, paused: f.v.paused || f.v.ended, rs: f.v.readyState } });
    } else if (isTop && ticks % 4 === 0) {
      post({ t: 'page', top: location.href, title: document.title }); // a aba existe, ainda sem vídeo
    } else if (!isTop && window.__telaoV && ticks % 4 === 0) {
      window.__telaoV = null; post({ t: 'gone' });
    }
  }, 500);

  chrome.runtime.onMessage.addListener((c) => {
    const v = window.__telaoV;
    if (!v || !c || c.t !== 'cmd') return;
    if (c.cmd === 'play') v.play().catch(() => {});
    if (c.cmd === 'pause') v.pause();
    if (c.cmd === 'seek' && !noSeek) v.currentTime = Number(c.time) || 0;
    if (c.cmd === 'volume') { v.volume = Math.min(1, Math.max(0, Number(c.v) || 0)); v.muted = Number(c.v) === 0; }
  });
  connect();
})();
