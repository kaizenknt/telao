// Telão — assistir junto: o vídeo toca no PC de cada um (sem tela preta de proteção, sem gastar a internet de
// quem transmite) e a sala só sincroniza tocar/pausar/pular. Quem entrar depois cai no ponto certo.
// Canal "sala": evento fixo "junto" = { kind (yt|twitch|vimeo|kick|hls|file), id|src, playing, pos, at (relógio da sala), by, title }
// e "contagem" = { at, site } para sites com proteção de cópia (Netflix etc.).
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

    if ((m = url.match(/vimeo\.com\/(?:video\/|channels\/[^/]+\/)?(\d{5,})/i))) return { kind: 'vimeo', id: m[1], pos: 0 };

    if (/^https?:\/\/\S+\.m3u8(\?\S*)?$/i.test(url)) return { kind: 'hls', src: url, pos: 0 };
    if (/^https?:\/\/\S+\.(mp4|webm|m4v|mov)(\?\S*)?$/i.test(url)) return { kind: 'file', src: url, pos: 0 };
    // sites com proteção de cópia: ninguém consegue embutir; fica a contagem regressiva
    if ((m = url.match(/(netflix|primevideo|amazon|disneyplus|max\.com|hbomax|globoplay|starplus|paramountplus|crunchyroll|apple\.com\/tv|tv\.apple)/i))) return { kind: 'drm', site: m[1] };
    // qualquer outro site (Twitch, Kick, sites de filme…): abre a página no navegador embutido e acha o vídeo nela
    if (/^https?:\/\/[^\s/]+\.[^\s/]+/i.test(url)) return { kind: 'web', src: url, pos: 0 };
    if (/^[^\s/]+\.[a-z]{2,}(\/\S*)?$/i.test(url)) return { kind: 'web', src: 'https://' + url, pos: 0 };
    return null;
  }
  const SITE = { yt: 'YouTube', twitch: 'Twitch', vimeo: 'Vimeo', kick: 'Kick', hls: 'transmissão', file: 'vídeo', web: 'site' };
  const BRIDGE = ['yt', 'twitch', 'vimeo', 'kick', 'hls'];
  const KINDS = [...BRIDGE, 'file', 'web'];
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'site'; } };

  // ---------- players (YouTube pela ponte no GitHub Pages; arquivo direto num <video>) ----------
  function bridgeMedia(box, s) {
    const f = document.createElement('iframe');
    f.src = `${PAGES}/telao/junto.html?k=${s.kind}&v=${encodeURIComponent(s.id || '')}&u=${encodeURIComponent(s.src || '')}`;
    f.allow = 'autoplay; encrypted-media; picture-in-picture';
    f.referrerPolicy = 'strict-origin-when-cross-origin';
    box.appendChild(f);
    const st = { ready: false, time: 0, dur: 0, ps: -1, title: '', tracks: [], levels: [], quality: '', live: false, noControl: false };
    const cmd = (o) => { try { f.contentWindow.postMessage({ telaoCmd: 1, ...o }, PAGES); } catch {} };
    const onMsg = (e) => {
      if (e.source !== f.contentWindow || !e.data || !e.data.telaoJunto) return;
      const m = e.data;
      if (m.type === 'ready') { st.ready = true; api_.onReady && api_.onReady(); }
      if (m.type === 'tick') {
        st.time = m.time || 0; st.dur = m.duration || 0; st.ps = m.state; st.quality = m.quality || ''; st.live = !!m.live; st.noControl = !!m.noControl;
        if (m.title) { st.title = m.title; api_.onTitle && api_.onTitle(m.title); }
        if (m.tracks) { st.tracks = m.tracks; api_.onOptions && api_.onOptions(); }
        if (m.levels) { st.levels = m.levels; api_.onOptions && api_.onOptions(); }
      }
      if (m.type === 'note') toast(m.text, 5000);
      if (m.type === 'error') api_.onError && api_.onError(
        m.code === 101 || m.code === 150 ? 'O dono deste vídeo não deixa ele tocar fora do YouTube.'
          : m.code === 'script' ? `Não consegui carregar o player do ${SITE[s.kind]}.`
          : `O ${SITE[s.kind]} não conseguiu tocar este vídeo.`);
    };
    window.addEventListener('message', onMsg);
    const timeout = setTimeout(() => { if (!st.ready) api_.onError && api_.onError(`Não consegui abrir o player do ${SITE[s.kind]}. Confira o link e a internet.`); }, 15000);
    const api_ = {
      play: () => cmd({ cmd: 'play' }), pause: () => cmd({ cmd: 'pause' }),
      seek: (t) => { st.time = t; cmd({ cmd: 'seek', t }); }, volume: (v) => cmd({ cmd: 'volume', v }),
      time: () => st.time, duration: () => st.dur, playing: () => st.ps === 1 || st.ps === 3, ready: () => st.ready,
      // legenda e qualidade: de cada pessoa, não sincronizam
      captions: (lang) => cmd({ cmd: 'captions', lang }), quality: (q) => cmd({ cmd: 'quality', q }),
      tracks: () => st.tracks, levels: () => st.levels, currentQuality: () => st.quality,
      live: () => st.live, noControl: () => st.noControl,
      destroy: () => { clearTimeout(timeout); window.removeEventListener('message', onMsg); f.remove(); },
    };
    return api_;
  }
  /* ---------- qualquer site: a página aberta aqui dentro, o Telão acha o <video> dela ----------
   * Cada um usa o player do próprio site (escolher servidor, legenda, qualidade, tela cheia). O Telão
   * sincroniza tocar/pausar/posição: o que alguém fizer no player do site vale para todos.
   */
  function webMedia(box, src) {
    const wv = document.createElement('webview');
    wv.setAttribute('src', src);
    wv.setAttribute('partition', 'persist:junto');
    wv.setAttribute('webpreferences', 'contextIsolation=yes, sandbox=yes');
    box.appendChild(wv);
    const st = { id: null, found: false, time: 0, dur: 0, paused: true, live: false, rs: 0, title: '' };
    let pollT = null, failT = null, alive = true;
    const cmd = (c) => { if (st.id) api.web.cmd(st.id, c).catch(() => {}); };
    wv.addEventListener('dom-ready', () => {
      try { st.id = wv.getWebContentsId(); } catch {}
      if (!pollT) pollT = setInterval(async () => {
        if (!alive || !st.id) return;
        const r = await api.web.probe(st.id).catch(() => null);
        if (!r || !alive) return;
        if (r.found) {
          const first = !st.found;
          Object.assign(st, { found: true, time: r.time, dur: r.dur, paused: r.paused || r.ended, live: r.live, rs: r.rs });
          if (first) { api_.onReady && api_.onReady(); api_.onFound && api_.onFound(true); }
          api_.onTick && api_.onTick(st);
        } else if (st.found) { st.found = false; api_.onFound && api_.onFound(false); }
      }, 600);
    });
    wv.addEventListener('page-title-updated', (e) => { st.title = e.title; api_.onTitle && api_.onTitle(e.title); });
    wv.addEventListener('did-fail-load', (e) => {
      if (e.isMainFrame && e.errorCode !== -3) api_.onError && api_.onError(`Não consegui abrir ${hostOf(src)} (${e.errorDescription || 'erro ' + e.errorCode}).`);
    });
    failT = setTimeout(() => { if (!st.found && alive) api_.onFound && api_.onFound(false, true); }, 12000);
    const api_ = {
      play: () => cmd({ cmd: 'play' }), pause: () => cmd({ cmd: 'pause' }),
      seek: (t) => { st.time = t; cmd({ cmd: 'seek', t }); }, volume: (v) => cmd({ cmd: 'volume', v }),
      time: () => st.time, duration: () => st.dur, playing: () => !st.paused, ready: () => st.found,
      live: () => st.live, noControl: () => false, web: true, raw: () => st,
      destroy: () => { alive = false; clearInterval(pollT); clearTimeout(failT); wv.remove(); },
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
      live: () => false, noControl: () => false,
      destroy: () => { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); },
    };
    v.addEventListener('loadedmetadata', () => api_.onReady && api_.onReady());
    v.addEventListener('error', () => api_.onError && api_.onError('Não consegui abrir este arquivo de vídeo.'));
    return api_;
  }

  // ---------- player do site: perceber play/pausa/pulo feitos lá dentro ----------
  let quietUntil = 0; // depois de um comando nosso, ignora as mudanças (foram nossas)
  let prevSite = null; // última leitura do player do site
  function webLocalChange(st) {
    const s = J.state, prev = prevSite, nowMs = Date.now();
    prevSite = { paused: st.paused, time: st.time, at: nowMs };
    // só reage a uma MUDANÇA dentro do site (alguém clicou lá), nunca ao estado parado de quem acabou de entrar
    if (!s || !prev || nowMs < quietUntil || st.rs < 2) return;
    if (st.paused !== prev.paused) return publish({ playing: !st.paused, pos: st.time }, true); // play/pausa no site
    const drift = st.time - (prev.time + (prev.paused ? 0 : (nowMs - prev.at) / 1000));
    if (!st.live && Math.abs(drift) > 5) return publish({ pos: st.time }, true); // pulou no site
  }

  // ---------- sincronizar ----------
  const expected = (s) => s.pos + (s.playing ? (now() - s.at) / 1000 : 0);
  function apply(tol = 1.2) {
    const s = J.state, m = J.media;
    if (!s || !m || !m.ready() || m.noControl()) return;
    const want = expected(s);
    let did = false;
    if (!m.live() && Math.abs(m.time() - want) > tol) { m.seek(want); did = true; } // ao vivo não tem como pular
    if (s.playing && !m.playing()) { m.play(); did = true; }
    if (!s.playing && m.playing()) { m.pause(); did = true; }
    if (did) quietUntil = Date.now() + 2500;
  }
  async function publish(patch, fromSite) {
    if (!J.state) return;
    J.state = { ...J.state, ...patch, at: now(), by2: cfg.name };
    if (!fromSite) apply(0.3); else quietUntil = Date.now() + 1500;
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
    prevSite = null;
    J.media = BRIDGE.includes(s.kind) ? bridgeMedia(box, s) : s.kind === 'web' ? webMedia(box, s.src) : fileMedia(box, s.src);
    $('#junto').classList.toggle('web', s.kind === 'web');
    show($('#junto-webhint'), s.kind === 'web');
    $('#junto-webhint').textContent = 'Abra o vídeo e dê play no player do site (escolha servidor/legenda nele). O Telão acha o vídeo e sincroniza com todo mundo.';
    if (J.media.web) {
      J.media.onFound = (ok, late) => {
        if (ok) { $('#junto-webhint').textContent = '✓ Achei o vídeo da página: tocar, pausar e pular agora valem para todos.'; setTimeout(() => show($('#junto-webhint'), false), 5000); }
        else if (late) $('#junto-webhint').textContent = 'Ainda não achei o vídeo nesta página. Abra o filme/episódio e dê play uma vez no player do site.';
        else { show($('#junto-webhint'), true); $('#junto-webhint').textContent = 'O vídeo sumiu da página (trocou de episódio ou de servidor?). Dê play de novo.'; }
      };
      // o que a pessoa fizer no player do próprio site vale para todos
      J.media.onTick = (st) => webLocalChange(st);
    }
    J.media.onReady = () => {
      J.media.volume(+$('#junto-vol').value); apply(0.3);
      // escolhas guardadas de legenda e qualidade
      if (J.media.captions) { J.media.captions(prefs[ck()] || null); if (prefs[qk()] && prefs[qk()] !== 'auto') J.media.quality(prefs[qk()]); }
    };
    J.media.onOptions = () => { if (!document.querySelector('.jmenu:not(.hidden)')) renderMenus(); };
    J.media.onError = (msg) => { $('#junto-err').textContent = msg; show($('#junto-err'), true); };
    J.media.onTitle = (t) => { if (J.state && !J.state.title && J.state.by === cfg.name) publish({ title: t }); };
    show($('#junto-err'), false);
    show($('#junto-cc'), BRIDGE.includes(s.kind) && s.kind !== 'kick'); show($('#junto-q'), BRIDGE.includes(s.kind) && s.kind !== 'kick');
    if (s.kind === 'web') { show($('#junto-cc'), false); show($('#junto-q'), false); }
    closeMenus();
  }

  /* ---------- legenda e qualidade (de cada um) ---------- */
  const prefs = (() => { try { return JSON.parse(localStorage.getItem('telao.junto') || '{}'); } catch { return {}; } })();
  // legenda e qualidade guardadas por site (os códigos mudam de um para outro)
  const ck = () => 'cc_' + (J.state ? J.state.kind : ''), qk = () => 'q_' + (J.state ? J.state.kind : '');
  const savePrefs = () => { try { localStorage.setItem('telao.junto', JSON.stringify(prefs)); } catch {} };
  function closeMenus() { document.querySelectorAll('.jmenu').forEach((m) => show(m, false)); }
  function menuItem(label, on, fn) {
    const b = document.createElement('button');
    b.className = 'jm-item' + (on ? ' on' : ''); b.textContent = label;
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); closeMenus(); renderMenus(); });
    return b;
  }
  function renderMenus(labelOnly) {
    const m = J.media; if (!m || !m.tracks) return;
    const want = prefs[qk()] || 'auto', cur = m.currentQuality();
    const wantLabel = (m.levels().find((l) => l.id === want) || {}).label;
    $('#junto-q span').textContent = want === 'auto' || !wantLabel ? `Auto${cur ? ' · ' + cur : ''}` : wantLabel;
    $('#junto-cc').classList.toggle('on', !!prefs[ck()]);
    if (labelOnly === true) return; // só o rótulo (não redesenha o menu embaixo do mouse)
    const cc = $('#jm-cc'); cc.textContent = '';
    cc.appendChild(menuItem('Desligada', !prefs[ck()], () => { prefs[ck()] = null; savePrefs(); m.captions(null); }));
    const tr = m.tracks();
    for (const t of tr) cc.appendChild(menuItem(t.name, prefs[ck()] === t.code, () => { prefs[ck()] = t.code; savePrefs(); m.captions(t.code); }));
    if (!tr.length) { const p = document.createElement('p'); p.className = 'jm-empty'; p.textContent = 'Este vídeo não tem legendas.'; cc.appendChild(p); }

    const qm = $('#jm-q'); qm.textContent = '';
    qm.appendChild(menuItem('Automática', want === 'auto', () => { prefs[qk()] = 'auto'; savePrefs(); m.quality('auto'); }));
    for (const l of m.levels()) qm.appendChild(menuItem(l.label, want === l.id, () => { prefs[qk()] = l.id; savePrefs(); m.quality(l.id); }));
    if (!m.levels().length) { const p = document.createElement('p'); p.className = 'jm-empty'; p.textContent = 'Aparece quando o vídeo começar.'; qm.appendChild(p); }
  }
  function toggleMenu(id) {
    const el = $(id), was = !el.classList.contains('hidden');
    closeMenus(); renderMenus();
    show(el, !was);
    wake();
  }
  $('#junto-cc').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu('#jm-cc'); });
  $('#junto-q').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu('#jm-q'); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.jmenu')) closeMenus(); });

  /* ---------- barras somem quando o mouse fica parado ---------- */
  let idleT = null;
  function wake() {
    const j = $('#junto');
    j.classList.remove('idle');
    clearTimeout(idleT);
    idleT = setTimeout(() => {
      // não esconde com um menu aberto ou com o mouse em cima das barras
      if (document.querySelector('.jmenu:not(.hidden)') || j.querySelector('.junto-top:hover, .junto-ctrl:hover')) return wake();
      j.classList.add('idle');
    }, 2800);
  }
  $('#junto').addEventListener('mousemove', wake);
  $('#junto').addEventListener('mouseleave', () => { clearTimeout(idleT); idleT = setTimeout(() => $('#junto').classList.add('idle'), 800); });
  $('#junto-full').addEventListener('click', () => { if (typeof toggleFull === 'function') toggleFull(); });
  function openJunto() {
    if (!J.state) return;
    if (typeof selected !== 'undefined' && selected) closePlayer();
    J.open = true;
    show($('#stage-empty'), false); show($('#player'), false); show($('#junto'), true);
    mount();
    clearInterval(J.syncT);
    J.syncT = setInterval(() => { apply(1.6); renderUi(); if (J.media && J.media.tracks) renderMenus(true); }, 1000);
    wake();
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
      $('#junto-title').textContent = s.title || (s.kind === 'web' ? hostOf(s.src) : `Vídeo do ${SITE[s.kind] || 'site'}`);
      $('#junto-by').textContent = `aberto por ${s.by}` + (s.by2 && s.by2 !== s.by ? ` · último controle: ${s.by2}` : '');
    }
    if (!J.open || !J.media) return;
    const live = J.media.live(), noc = J.media.noControl();
    $('#junto').classList.toggle('is-live', live); $('#junto').classList.toggle('no-control', noc);
    const t = J.media.time(), d = J.media.duration();
    $('#junto-time').textContent = noc ? 'ao vivo · cada um controla o seu' : live ? 'AO VIVO' : `${fmt(t)} / ${fmt(d)}`;
    const r = $('#junto-seek');
    if (!r.matches(':active')) { r.max = String(Math.max(1, Math.floor(d))); r.value = String(Math.floor(t)); }
    $('#junto-play').textContent = s && s.playing ? '❚❚' : '▶';
    $('#junto-play').title = s && s.playing ? 'Pausar para todos (espaço)' : 'Tocar para todos (espaço)';
  }

  // ---------- eventos da sala ----------
  window.onSalaEvent = function (ev) {
    if (ev.type === 'junto' && ev.data && KINDS.includes(ev.data.kind)) {
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
    if (ev.type === 'contagem' && ev.data && typeof ev.data.at === 'number' && !ev.replay) countdown(ev.data, ev.from);
  };

  /* ---------- Netflix, Prime, Disney+…: contagem regressiva sincronizada ----------
   * Esses sites têm proteção de cópia (ninguém consegue embutir nem transmitir sem tela preta). Cada um abre no
   * próprio navegador/app, pausa no mesmo ponto, e a contagem aparece ao mesmo tempo para todos: no "JÁ!", play.
   */
  const SITES = { netflix: 'Netflix', primevideo: 'Prime Video', amazon: 'Prime Video', disneyplus: 'Disney+', 'max.com': 'Max', hbomax: 'Max',
    globoplay: 'Globoplay', starplus: 'Star+', paramountplus: 'Paramount+', crunchyroll: 'Crunchyroll', 'apple.com/tv': 'Apple TV+', 'tv.apple': 'Apple TV+' };
  let cdT = null;
  function countdown(d, from) {
    const el = $('#countdown'), num = $('#cd-num'), msg = $('#cd-msg');
    $('#cd-site').textContent = `${from} chamou a contagem${d.site ? ' · ' + d.site : ''}`;
    msg.textContent = d.note || 'Deixe pausado no mesmo ponto e aperte play no "JÁ!"';
    show(el, true);
    clearInterval(cdT);
    cdT = setInterval(() => {
      const left = (d.at - now()) / 1000;
      if (left > 0) { num.textContent = String(Math.ceil(left)); el.classList.remove('go'); }
      else { num.textContent = 'JÁ!'; el.classList.add('go'); if (left < -1.6) { clearInterval(cdT); show(el, false); } }
    }, 50);
  }
  async function startCountdown(site, note) {
    await syncClock();
    await api.ev.send({ ch: 'sala', type: 'contagem', data: { at: now() + 4200, site, note } });
  }

  // ---------- botões ----------
  $('#btn-junto').addEventListener('click', () => {
    // já tem vídeo aberto: dá para voltar para ele ou colar outro link (substitui para todos)
    show($('#junto-current'), !!J.state);
    if (J.state) $('#junto-current-text').textContent = `Aberto agora: ${J.state.title || 'vídeo do ' + (SITE[J.state.kind] || 'site')}`;
    $('#junto-url').value = ''; show($('#junto-url-err'), false);
    $('#dlg-junto').showModal(); $('#junto-url').focus();
  });
  $('#btn-junto-go').addEventListener('click', async () => {
    const p = parse($('#junto-url').value);
    if (!p) { $('#junto-url-err').textContent = 'Isso não parece um link. Cole o endereço da página do vídeo (começando com https://).'; show($('#junto-url-err'), true); return; }
    $('#dlg-junto').close();
    if (p.kind === 'drm') {
      const site = SITES[p.site.toLowerCase()] || 'esse site';
      toast(`${site} tem proteção de cópia: cada um abre no próprio navegador e vocês dão play juntos na contagem.`, 7000);
      return startCountdown(site);
    }
    await syncClock();
    J.state = { kind: p.kind, id: p.id, src: p.src, playing: false, pos: p.pos, at: now(), by: cfg.name, title: '' };
    openJunto();
    await api.ev.send({ ch: 'sala', type: 'junto', data: J.state, sticky: true });
    toast('Pronto: a galera recebeu o convite. Aperte ▶ quando todos estiverem dentro.');
  });
  $('#junto-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-junto-go').click(); });
  $('#btn-countdown').addEventListener('click', () => { $('#dlg-junto').close(); startCountdown(''); });
  $('#junto-bar-go').addEventListener('click', openJunto);
  $('#junto-current-go').addEventListener('click', () => { $('#dlg-junto').close(); openJunto(); });
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
    if ((e.key === 'c' || e.key === 'C') && J.state && BRIDGE.includes(J.state.kind)) toggleMenu('#jm-cc');
    if (e.key === 'f' || e.key === 'F') { e.stopImmediatePropagation(); $('#junto-full').click(); }
    wake();
  });

  api.ev.sub('sala');
  setInterval(syncClock, 30000);
  window.TelaoJunto = { parse, state: () => J.state, open: openJunto, close: closeJunto, countdown: startCountdown };
})();
