// Telão — assistir junto: o vídeo toca no PC de cada um (sem tela preta de proteção, sem gastar a internet de
// quem transmite) e a sala só sincroniza tocar/pausar/pular. Quem entrar depois cai no ponto certo.
// Canal "sala": evento fixo "junto" = { kind, id|src, playing, pos, at (relógio da sala), by, title }.
(function () {
  const PAGES = 'https://kaizenknt.github.io';
  const J = { state: null, open: false, media: null, offset: 0, syncT: null, ui: null };
  const fmt = (t) => { t = Math.max(0, Math.floor(t || 0)); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0'); };
  const now = () => Date.now() + J.offset; // relógio da sala
  async function syncClock() { try { const s = await api.ev.now(); if (typeof s === 'number') J.offset = s - Date.now(); } catch {} }

  // ---------- links aceitos ----------
  function parse(url) {
    url = String(url || '').trim();
    let m = url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
    if (m) {
      const t = url.match(/[?&#]t=(?:(\d+)h)?(?:(\d+)m)?(\d+)s?/);
      const start = t ? (+t[1] || 0) * 3600 + (+t[2] || 0) * 60 + (+t[3] || 0) : 0;
      return { kind: 'yt', id: m[1], pos: start };
    }
    if (/^https?:\/\/\S+\.(mp4|webm|m4v|mov)(\?\S*)?$/i.test(url)) return { kind: 'file', src: url, pos: 0 };
    return null;
  }

  // ---------- players (YouTube pela ponte no GitHub Pages; arquivo direto num <video>) ----------
  function ytMedia(box, id) {
    const f = document.createElement('iframe');
    f.src = `${PAGES}/telao/junto.html?v=${encodeURIComponent(id)}`;
    f.allow = 'autoplay; encrypted-media; picture-in-picture';
    f.referrerPolicy = 'strict-origin-when-cross-origin';
    box.appendChild(f);
    const st = { ready: false, time: 0, dur: 0, ps: -1, title: '' };
    const cmd = (o) => { try { f.contentWindow.postMessage({ telaoCmd: 1, ...o }, PAGES); } catch {} };
    const onMsg = (e) => {
      if (e.source !== f.contentWindow || !e.data || !e.data.telaoJunto) return;
      const m = e.data;
      if (m.type === 'ready') { st.ready = true; api_.onReady && api_.onReady(); }
      if (m.type === 'tick') { st.time = m.time || 0; st.dur = m.duration || 0; st.ps = m.state; if (m.title) { st.title = m.title; api_.onTitle && api_.onTitle(m.title); } }
      if (m.type === 'error') api_.onError && api_.onError(m.code === 101 || m.code === 150 ? 'O dono deste vídeo não deixa ele tocar fora do YouTube.' : 'O YouTube não conseguiu tocar este vídeo.');
    };
    window.addEventListener('message', onMsg);
    const timeout = setTimeout(() => { if (!st.ready) api_.onError && api_.onError('Não consegui abrir o player do YouTube. A página do Telão no GitHub (Pages) está ligada?'); }, 15000);
    const api_ = {
      play: () => cmd({ cmd: 'play' }), pause: () => cmd({ cmd: 'pause' }),
      seek: (t) => { st.time = t; cmd({ cmd: 'seek', t }); }, volume: (v) => cmd({ cmd: 'volume', v }),
      time: () => st.time, duration: () => st.dur, playing: () => st.ps === 1 || st.ps === 3, ready: () => st.ready,
      destroy: () => { clearTimeout(timeout); window.removeEventListener('message', onMsg); f.remove(); },
    };
    return api_;
  }
  function fileMedia(box, src) {
    const v = document.createElement('video');
    v.src = src; v.playsInline = true; v.preload = 'auto';
    box.appendChild(v);
    const api_ = {
      play: () => v.play().catch(() => {}), pause: () => v.pause(), seek: (t) => { v.currentTime = t; }, volume: (x) => { v.volume = x; },
      time: () => v.currentTime, duration: () => v.duration || 0, playing: () => !v.paused, ready: () => v.readyState >= 1,
      destroy: () => { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); },
    };
    v.addEventListener('loadedmetadata', () => api_.onReady && api_.onReady());
    v.addEventListener('error', () => api_.onError && api_.onError('Não consegui abrir este arquivo de vídeo.'));
    return api_;
  }

  // ---------- sincronizar ----------
  const expected = (s) => s.pos + (s.playing ? (now() - s.at) / 1000 : 0);
  function apply(tol = 1.2) {
    const s = J.state, m = J.media;
    if (!s || !m || !m.ready()) return;
    const want = expected(s);
    if (Math.abs(m.time() - want) > tol) m.seek(want);
    if (s.playing && !m.playing()) m.play();
    if (!s.playing && m.playing()) m.pause();
  }
  async function publish(patch) {
    if (!J.state) return;
    J.state = { ...J.state, ...patch, at: now(), by2: cfg.name };
    apply(0.3);
    renderUi();
    await api.ev.send({ ch: 'sala', type: 'junto', data: J.state, sticky: true });
  }
  const sameSource = (a, b) => a && b && a.kind === b.kind && (a.id || a.src) === (b.id || b.src);

  // ---------- abrir / fechar ----------
  function mount() {
    const box = $('#junto-frame');
    if (J.media) { J.media.destroy(); J.media = null; }
    box.textContent = '';
    const s = J.state;
    J.media = s.kind === 'yt' ? ytMedia(box, s.id) : fileMedia(box, s.src);
    J.media.onReady = () => { J.media.volume(+$('#junto-vol').value); apply(0.3); };
    J.media.onError = (msg) => { $('#junto-err').textContent = msg; show($('#junto-err'), true); };
    J.media.onTitle = (t) => { if (J.state && !J.state.title && J.state.by === cfg.name) publish({ title: t }); };
    show($('#junto-err'), false);
  }
  function openJunto() {
    if (!J.state) return;
    if (typeof selected !== 'undefined' && selected) closePlayer();
    J.open = true;
    show($('#stage-empty'), false); show($('#player'), false); show($('#junto'), true);
    mount();
    clearInterval(J.syncT);
    J.syncT = setInterval(() => { apply(1.6); renderUi(); }, 1000);
    syncClock();
    renderUi();
  }
  function closeJunto() {
    J.open = false;
    clearInterval(J.syncT);
    if (J.media) { J.media.destroy(); J.media = null; }
    show($('#junto'), false);
    if (!selected) show($('#stage-empty'), true);
    renderUi();
  }

  function renderUi() {
    const s = J.state, bar = $('#junto-bar');
    show(bar, !!s && !J.open);
    if (s) {
      $('#junto-bar-text').textContent = `${s.by} abriu ${s.title ? '“' + s.title + '”' : 'um vídeo'} para assistir junto`;
      $('#junto-title').textContent = s.title || (s.kind === 'yt' ? 'Vídeo do YouTube' : 'Vídeo');
      $('#junto-by').textContent = `aberto por ${s.by}` + (s.by2 && s.by2 !== s.by ? ` · último controle: ${s.by2}` : '');
    }
    if (!J.open || !J.media) return;
    const t = J.media.time(), d = J.media.duration();
    $('#junto-time').textContent = `${fmt(t)} / ${fmt(d)}`;
    const r = $('#junto-seek');
    if (!r.matches(':active')) { r.max = String(Math.max(1, Math.floor(d))); r.value = String(Math.floor(t)); }
    $('#junto-play').textContent = s && s.playing ? '❚❚' : '▶';
    $('#junto-play').title = s && s.playing ? 'Pausar para todos (espaço)' : 'Tocar para todos (espaço)';
  }

  // ---------- eventos da sala ----------
  window.onSalaEvent = function (ev) {
    if (ev.type === 'junto' && ev.data && (ev.data.kind === 'yt' || ev.data.kind === 'file')) {
      const prev = J.state;
      J.state = ev.data;
      if (J.open && !sameSource(prev, J.state)) mount();
      apply(0.6);
      if (!prev && !ev.replay && ev.from !== cfg.name) toastAction(`${ev.data.by} abriu um vídeo para assistir junto.`, 'Entrar', openJunto, 9000);
      renderUi();
    }
    if (ev.type === 'junto-fim') {
      const was = !!J.state;
      J.state = null;
      if (J.open) closeJunto();
      renderUi();
      if (was && ev.from !== cfg.name) toast(`${ev.from} encerrou o assistir junto.`);
    }
  };

  // ---------- botões ----------
  $('#btn-junto').addEventListener('click', () => {
    if (J.state) return openJunto();
    $('#junto-url').value = ''; show($('#junto-url-err'), false);
    $('#dlg-junto').showModal(); $('#junto-url').focus();
  });
  $('#btn-junto-go').addEventListener('click', async () => {
    const p = parse($('#junto-url').value);
    if (!p) { $('#junto-url-err').textContent = 'Cole um link do YouTube (ou de um arquivo .mp4/.webm).'; show($('#junto-url-err'), true); return; }
    $('#dlg-junto').close();
    await syncClock();
    J.state = { kind: p.kind, id: p.id, src: p.src, playing: false, pos: p.pos, at: now(), by: cfg.name, title: '' };
    openJunto();
    await api.ev.send({ ch: 'sala', type: 'junto', data: J.state, sticky: true });
    toast('Pronto: a galera recebeu o convite. Aperte ▶ quando todos estiverem dentro.');
  });
  $('#junto-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-junto-go').click(); });
  $('#junto-bar-go').addEventListener('click', openJunto);
  $('#junto-play').addEventListener('click', () => J.media && publish({ playing: !J.state.playing, pos: J.media.time() }));
  $('#junto-back').addEventListener('click', () => J.media && publish({ pos: Math.max(0, J.media.time() - 10) }));
  $('#junto-fwd').addEventListener('click', () => J.media && publish({ pos: J.media.time() + 10 }));
  $('#junto-seek').addEventListener('change', (e) => publish({ pos: +e.target.value }));
  $('#junto-vol').addEventListener('input', (e) => J.media && J.media.volume(+e.target.value));
  $('#junto-leave').addEventListener('click', closeJunto);
  $('#junto-end').addEventListener('click', async () => {
    await api.ev.send({ ch: 'sala', type: 'junto-fim', clearSticky: true });
    J.state = null; closeJunto();
  });
  document.addEventListener('keydown', (e) => {
    if (!J.open || e.target.closest('input, textarea, dialog')) return;
    if (e.code === 'Space') { e.preventDefault(); $('#junto-play').click(); }
    if (e.key === 'ArrowLeft') $('#junto-back').click();
    if (e.key === 'ArrowRight') $('#junto-fwd').click();
  });

  api.ev.sub('sala');
  setInterval(syncClock, 30000);
  window.TelaoJunto = { parse, state: () => J.state, open: openJunto, close: closeJunto };
})();
