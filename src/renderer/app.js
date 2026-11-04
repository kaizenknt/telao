// Telão — interface
const $ = (s) => document.querySelector(s);
const api = window.telao;

let cfg = null;
let streams = [];
let selected = null;   // nome da transmissão que estou assistindo
let stState = { state: 'parado' };
let hostState = 'parado';
let pollTimer = null;
let lastPollOk = null;

/* ---------- utilidades ---------- */
function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}
function toastAction(msg, label, fn, ms = 7000) {
  toast(msg, ms);
  const t = $('#toast');
  const b = document.createElement('button');
  b.className = 'toast-btn'; b.textContent = label;
  b.onclick = () => { fn(); t.classList.add('hidden'); };
  t.appendChild(b);
}
const show = (el, on = true) => el.classList.toggle('hidden', !on);
function ago(iso) {
  if (!iso) return '';
  const m = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
  if (m < 1) return 'agora';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}
function genPassword() {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789';
  const r = crypto.getRandomValues(new Uint32Array(12));
  return Array.from(r, (n) => a[n % a.length]).join('').replace(/(.{4})(?=.)/g, '$1-');
}
const initials = (n) => n.replace(/[-_]+/g, ' ').trim().slice(0, 2).toUpperCase();
function hue(n) { let h = 0; for (const c of n) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }

/* ---------- primeira vez ---------- */
function setupOnboarding() {
  let mode = null;
  const name = $('#ob-name'), invite = $('#ob-invite'), go = $('#ob-go'), err = $('#ob-error');
  const validate = () => { go.disabled = !(name.value.trim() && mode && (mode === 'host' || invite.value.trim())); };
  document.querySelectorAll('.choice').forEach((b) => b.addEventListener('click', () => {
    mode = b.dataset.mode;
    document.querySelectorAll('.choice').forEach((x) => x.classList.toggle('on', x === b));
    show($('#ob-guest'), mode === 'guest');
    go.textContent = mode === 'host' ? 'Criar sala' : 'Entrar na sala';
    if (mode === 'guest') invite.focus();
    validate();
  }));
  name.addEventListener('input', validate);
  invite.addEventListener('input', validate);
  go.addEventListener('click', async () => {
    show(err, false);
    if (mode === 'guest') {
      const inv = await api.invite.read(invite.value);
      if (!inv) { err.textContent = 'Esse código não parece um convite do Telão.'; show(err); return; }
      cfg = await api.cfg.set({ name: name.value.trim(), hosting: false, server: inv.server, password: inv.password });
    } else {
      cfg = await api.cfg.set({ name: name.value.trim(), hosting: true, password: cfg.password || genPassword() });
    }
    startApp();
    if (mode === 'host') setTimeout(openInvite, 400);
  });
  show($('#onboarding'));
  name.focus();
}

/* ---------- app ---------- */
async function startApp() {
  show($('#onboarding'), false);
  show($('#app'));
  renderMe();
  renderHost();
  stState = await api.stream.state();
  renderStream();
  checkFw();
  api.net.state().then(renderNet);
  api.upd.state().then((s) => { updState = s; renderUpd(); });
  poll();
  clearInterval(pollTimer);
  pollTimer = setInterval(poll, 2500);
}

function renderMe() {
  $('#me-name').textContent = cfg.name;
  $('#host-title').textContent = cfg.hosting ? 'Sala neste PC' : 'Sala do amigo';
  $('#btn-invite').textContent = cfg.hosting ? 'Convidar amigos' : 'Copiar convite da sala';
}

/* ---------- lista ao vivo ---------- */
let goneCount = 0;
async function poll() {
  const r = await api.rooms.list();
  const conn = $('#conn');
  if (!r.ok) {
    lastPollOk = false;
    conn.className = 'conn bad';
    $('#conn-text').textContent = cfg.hosting && hostState !== 'rodando' ? 'Servidor iniciando…' : r.error;
    streams = [];
  } else {
    lastPollOk = true;
    conn.className = 'conn ok';
    $('#conn-text').textContent = cfg.hosting ? 'Sala aberta' : `Conectado a ${cfg.server}`;
    streams = r.items.sort((a, b) => a.name.localeCompare(b.name));
    // a sala mantém a conexão de quem assiste viva nas trocas de qualidade; então quem decide que a
    // transmissão acabou é a lista: fora do ar por ~8 s seguidos = fecha o player
    if (selected && !streams.some((x) => x.name === selected)) {
      if (++goneCount >= 3) { const n = selected; closePlayer(); toast(`${n} saiu do ar.`); }
    } else goneCount = 0;
    autoWatchCheck();
  }
  renderStreams();
}

/* ---------- abrir sozinho quando alguém começa a transmitir ----------
 * Só para transmissões que COMEÇAM com o app aberto (não abre nada ao ligar o Telão). Uma queda rápida
 * (menos de 30 s fora do ar) não conta como começo novo.
 */
const lastSeen = new Map();
let autoWatchReady = false;
function autoWatchCheck() {
  const now = Date.now();
  const fresh = streams.map((x) => x.name).filter((n) => n !== cfg.path && (!lastSeen.has(n) || now - lastSeen.get(n) > 30000));
  for (const x of streams) lastSeen.set(x.name, now);
  if (!autoWatchReady) { autoWatchReady = true; return; }
  if (!fresh.length) return;
  const n = fresh[0];
  const busy = !!selected || !$('#junto').classList.contains('hidden');
  if (cfg.autoWatch !== false && !busy) { watch(n); toast(`${n} começou a transmitir: abrindo.`); }
  else if (selected !== n) toastAction(`${n} começou a transmitir.`, 'Assistir', () => watch(n), 9000);
}

let lastStreamsKey = '';
function renderStreams() {
  const ul = $('#streams');
  // só redesenha a lista quando algo mudou (redesenhar no meio de um clique fazia o clique se perder)
  const key = JSON.stringify([selected, streams.map((s) => [s.name, s.viewers, ago(s.since)])]);
  if (key === lastStreamsKey && ul.childElementCount === streams.length) return;
  lastStreamsKey = key;
  ul.textContent = '';
  $('#live-count').textContent = streams.length;
  show($('#streams-empty'), streams.length === 0);
  for (const s of streams) {
    const mine = s.name === cfg.path;
    const li = document.createElement('li');
    li.className = 'stream' + (s.name === selected ? ' on' : '');
    li.innerHTML = `
      <span class="avatar" style="--h:${hue(s.name)}"></span>
      <span class="s-main"><b></b><small></small></span>
      <span class="live-dot" title="Ao vivo"></span>`;
    li.querySelector('.avatar').textContent = initials(s.name);
    li.querySelector('b').textContent = s.name + (mine ? ' (você)' : '');
    li.querySelector('small').textContent = `${s.viewers} assistindo · ${ago(s.since)}`;
    li.addEventListener('click', () => watch(s.name));
    ul.appendChild(li);
  }
  renderStageCards();
  // a transmissão que eu assistia acabou
  if (selected && lastPollOk && !streams.find((s) => s.name === selected)) {
    $('#loading-text').textContent = `${selected} parou de transmitir. Esperando voltar…`;
  }
}

/* palco vazio: cartões grandes de quem está ao vivo (um clique para assistir) */
function renderStageCards() {
  const grid = $('#stage-cards');
  const any = streams.length > 0;
  $('#stage-empty-title').textContent = any ? (streams.length === 1 ? 'Tem gente ao vivo' : `${streams.length} pessoas ao vivo`) : 'Ninguém ao vivo ainda';
  $('#stage-empty-sub').textContent = any ? 'Clique para assistir.' : 'Quando um amigo começar a transmitir, ele aparece aqui.';
  show($('#stage-marquee'), !any);
  grid.textContent = '';
  for (const s of streams) {
    const mine = s.name === cfg.path;
    const b = document.createElement('button');
    b.className = 'live-card';
    b.style.setProperty('--h', hue(s.name));
    b.innerHTML = `<span class="lc-top"><span class="live-badge">AO VIVO</span><span class="lc-time"></span></span>
      <span class="avatar big"></span><b></b><small></small><span class="lc-cta"></span>`;
    b.querySelector('.lc-time').textContent = ago(s.since);
    b.querySelector('.avatar').textContent = initials(s.name);
    b.querySelector('b').textContent = s.name + (mine ? ' (você)' : '');
    b.querySelector('small').textContent = `${s.viewers} assistindo`;
    b.querySelector('.lc-cta').textContent = mine ? 'Ver como está saindo' : 'Assistir';
    b.addEventListener('click', () => watch(s.name));
    grid.appendChild(b);
  }
}

/* ---------- player ---------- */
const video = $('#video');
const player = new WhepPlayer(video, {
  onStatus: ({ state, why }) => {
    if (state === 'playing') { show($('#loading'), false); startClipper(); return; }
    show($('#loading'));
    $('#loading-text').textContent =
      state === 'connecting' ? 'Conectando…' :
      state === 'reconnecting' && /não começou/.test(why) ? `${selected} não está transmitindo. Esperando voltar…` :
      state === 'reconnecting' ? `Reconectando (${why})…` :
      why || 'Erro';
  },
  onStats: (s) => {
    lastStats = s;
    const parts = [];
    if (s.codec) parts.push(String(s.codec).toUpperCase());
    if (s.w) parts.push(`${s.w}×${s.h}`);
    if (s.fps) parts.push(`${Math.round(s.fps)} fps`);
    if (s.mbps != null) parts.push(`${s.mbps.toFixed(1)} Mbps`);
    if (s.rtt != null) parts.push(`${Math.round(s.rtt * 1000)} ms`);
    if (s.lossPct != null) parts.push(`${s.lossPct.toFixed(1)}% perda`);
    if (s.codec) parts.push(s.codec);
    const el = $('#stats');
    el.textContent = parts.join(' · ');
    if (s.verdict) {
      const v = document.createElement('div');
      v.className = 'verdict ' + s.verdict.kind;
      v.textContent = s.verdict.text;
      el.appendChild(v);
    }
  },
});

/* ---------- quem assiste conta para quem transmite como está chegando ---------- */
let lastStats = null, fbTimer = null, av1HwPromise = null, av1LocalBad = 0;
function canAv1() {
  // AV1 só se a placa abre por hardware (senão pesa no processador)
  if (!av1HwPromise) av1HwPromise = (async () => {
    if (cfg.av1Bad) return false;
    try {
      const r = await navigator.mediaCapabilities.decodingInfo({ type: 'webrtc',
        video: { contentType: 'video/AV1', width: 1920, height: 1080, bitrate: 8000000, framerate: 60 } });
      return !!(r.supported && r.powerEfficient);
    } catch { return false; }
  })();
  return av1HwPromise;
}
function startFeedback(name) {
  clearInterval(fbTimer);
  lastStats = null; av1LocalBad = 0;
  fbTimer = setInterval(async () => {
    if (selected !== name || name === cfg.path) return;
    const s = lastStats || {};
    let av1 = await canAv1();
    // recebendo AV1 e o PC descartando quadros: avisa que AV1 não serve aqui (e guarda para a próxima)
    if (av1 && /av1/i.test(s.codec || '') && s.verdict?.kind === 'local') {
      if (++av1LocalBad >= 4) { av1 = false; av1HwPromise = Promise.resolve(false); cfg = await api.cfg.set({ av1Bad: true }); }
    } else av1LocalBad = 0;
    layerTick(name, s.verdict?.kind || null);
    api.rooms.feedback({
      path: name, viewer: cfg.name, av1, layer: lay.layer, wantsLight: lay.wantsLight,
      verdict: s.verdict?.kind || null, loss: s.lossPct ?? null, fps: s.arrivingFps ?? s.fps ?? null,
    }).catch(() => {});
  }, 3000);
}

/* ---------- qualidade por pessoa: versão máxima ou leve (720p) ----------
 * Automático: se a SUA internet está perdendo pacotes por ~9 s, pede a versão leve para quem transmite e passa
 * para ela quando aparecer. Depois de 2 min lisos tenta voltar para a máxima; se piorar de novo, volta e espera mais.
 */
const lay = { mode: 'auto', layer: 'main', wantsLight: false, bad: 0, ok: 0, okNeeded: 40, probeUntil: 0 };
function resetLayer() { Object.assign(lay, { layer: 'main', wantsLight: lay.mode === 'leve', bad: 0, ok: 0, okNeeded: 40, probeUntil: 0 }); renderQualityBtn(); }
async function playLayer(name, layer) {
  lay.layer = layer;
  const host = await api.serverHost(), auth = await api.authHeader(), av1 = await canAv1();
  const qs = `?tv=1&n=${encodeURIComponent(cfg.name)}&av1=${av1 ? 1 : 0}`;
  const pathName = layer === 'leve' ? name + '.leve' : name;
  player.play(`http://${host}:${cfg.ports.webrtc}/${encodeURIComponent(pathName)}/whep${qs}`, auth);
  renderQualityBtn();
}
function layerTick(name, verdict) {
  const hasLight = !!streams.find((x) => x.name === name)?.light;
  if (lay.mode === 'max') { lay.wantsLight = false; if (lay.layer !== 'main') playLayer(name, 'main'); return; }
  if (lay.mode === 'leve') { lay.wantsLight = true; if (hasLight && lay.layer !== 'leve') playLayer(name, 'leve'); return; }
  if (lay.layer === 'main') {
    lay.bad = verdict === 'rede' ? lay.bad + 1 : 0;
    // voltou para a máxima e piorou logo: volta para a leve e espera o dobro antes de tentar de novo
    if (lay.probeUntil && Date.now() < lay.probeUntil && lay.bad >= 2) { lay.okNeeded = Math.min(lay.okNeeded * 2, 200); lay.wantsLight = true; lay.probeUntil = 0; }
    if (lay.bad >= 3) lay.wantsLight = true;
    if (lay.wantsLight && hasLight) { lay.ok = 0; playLayer(name, 'leve'); toast('Sua internet oscilou: passei para a versão leve (720p) para não travar.'); }
  } else {
    lay.ok = verdict === 'ok' ? lay.ok + 1 : 0;
    if (!hasLight) { playLayer(name, 'main'); return; } // a versão leve sumiu
    if (lay.ok >= lay.okNeeded) { lay.ok = 0; lay.bad = 0; lay.wantsLight = false; lay.probeUntil = Date.now() + 30000; playLayer(name, 'main'); }
  }
}
function renderQualityBtn() {
  const b = $('#btn-quality'); if (!b) return;
  const cur = lay.layer === 'leve' ? '720p' : 'Máxima';
  b.querySelector('span').textContent = lay.mode === 'auto' ? `Auto · ${cur}` : lay.mode === 'max' ? 'Máxima' : 'Leve';
  b.classList.toggle('warn', lay.layer === 'leve');
}

async function watch(name) {
  goneCount = 0;
  if (!$('#junto').classList.contains('hidden') && window.TelaoJunto) window.TelaoJunto.close();
  selected = name;
  show($('#stage-empty'), false);
  show($('#player'));
  $('#who').textContent = name;
  // assistindo a si mesmo: começa mudo para não dar eco
  video.muted = name === cfg.path; renderVol();
  renderStreams();
  // playLayer se identifica para quem transmite (nome, se abre AV1) e escolhe a versão máxima ou leve
  resetLayer();
  const startLight = lay.mode === 'leve' && streams.find((x) => x.name === name)?.light;
  await playLayer(name, startLight ? 'leve' : 'main');
  startFeedback(name);
  marksWatch(name);
  wakePlayer(); // barras aparecem e somem sozinhas depois de alguns segundos
  clipper.stop();
}

function closePlayer() {
  selected = null;
  clearInterval(fbTimer);
  marksWatch(null); setPointing(false); clipper.stop();
  player.stop();
  show($('#player'), false);
  show($('#stage-empty'));
  renderStreams();
}

$('#vol').addEventListener('input', (e) => { video.volume = +e.target.value; video.muted = video.volume === 0; renderVol(); });
$('#btn-mute').addEventListener('click', () => { video.muted = !video.muted; renderVol(); });
function renderVol() {
  $('#ico-vol').setAttribute('d', video.muted
    ? 'M4 9v6h4l5 4V5L8 9H4Zm12 .4 1.4-1.4 2.1 2.1 2.1-2.1L23 9.4 20.9 11.5 23 13.6 21.6 15l-2.1-2.1-2.1 2.1L16 13.6l2.1-2.1L16 9.4Z'
    : 'M4 9v6h4l5 4V5L8 9H4Zm12.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4Z');
}
$('#btn-stats').addEventListener('click', () => $('#stats').classList.toggle('hidden'));
async function toggleFull() {
  const on = !document.body.classList.contains('full');
  document.body.classList.toggle('full', on);
  await api.win.fullscreen(on);
  video.play().catch(() => {}); // garante que nunca fica pausado ao trocar de modo
}
$('#btn-full').addEventListener('click', toggleFull);
video.addEventListener('dblclick', toggleFull);
// clique numa notificação / menu da bandeja → já abre assistindo essa pessoa
api.ui.onWatch((name) => { if (!$('#app').classList.contains('hidden')) watch(name); });
api.win.onFullscreen((on) => { document.body.classList.toggle('full', on); video.play().catch(() => {}); });
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, dialog')) return;
  if (e.key === 'f' || e.key === 'F') { if (selected) toggleFull(); }
  if (e.key === 'Escape') { if (document.body.classList.contains('full')) toggleFull(); else if (selected) closePlayer(); }
  if (e.key === 'm' || e.key === 'M') { video.muted = !video.muted; renderVol(); }
});
/* ---------- apontar, desenhar, reagir, clipe ---------- */
let marksCh = null;
const marksCanvas = $('#marks');
// onde a imagem realmente aparece dentro do player (o vídeo fica centralizado com faixas pretas)
function videoRect() {
  const W = video.clientWidth, H = video.clientHeight, vw = video.videoWidth || 16, vh = video.videoHeight || 9;
  const k = Math.min(W / vw, H / vh), w = vw * k, h = vh * k;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}
const marks = new window.TelaoMarks(marksCanvas, { contentRect: videoRect });
function marksWatch(name) {
  if (marksCh) api.ev.unsub(marksCh);
  marksCh = name ? 'p:' + name : null;
  marks.handle({ type: 'clear' });
  if (marksCh) api.ev.sub(marksCh);
}
api.ev.on((ev) => {
  if (ev.ch === marksCh) marks.handle(ev);
  else if (ev.ch === 'sala') onSalaEvent(ev);
});
const sendMark = (type, data) => { if (marksCh) api.ev.send({ ch: marksCh, type, data }); };

let pointing = false;
function setPointing(on) {
  pointing = on;
  $('#player').classList.toggle('pointing', on);
  $('#btn-point').classList.toggle('on', on);
  show($('#point-hint'), on);
}
$('#btn-point').addEventListener('click', () => setPointing(!pointing));
$('#btn-dnd').addEventListener('click', () => api.util.open('ms-settings:notifications'));
$('#btn-quality').addEventListener('click', () => {
  lay.mode = { auto: 'max', max: 'leve', leve: 'auto' }[lay.mode];
  lay.wantsLight = lay.mode === 'leve'; lay.bad = 0; lay.ok = 0;
  renderQualityBtn();
  toast(lay.mode === 'auto' ? 'Qualidade automática: troca sozinho se sua internet oscilar.'
    : lay.mode === 'max' ? 'Sempre a qualidade máxima.' : 'Versão leve (720p): pedindo para quem transmite…');
});
(() => {
  let down = null, stroke = null, sendT = null;
  const norm = (e) => {
    const r = videoRect(), b = marksCanvas.getBoundingClientRect();
    const x = (e.clientX - b.left - r.x) / r.w, y = (e.clientY - b.top - r.y) / r.h;
    return [Math.round(Math.min(1, Math.max(0, x)) * 1000) / 1000, Math.round(Math.min(1, Math.max(0, y)) * 1000) / 1000];
  };
  const flush = () => { if (stroke && stroke.buf.length) { sendMark('draw', { id: stroke.id, pts: stroke.buf }); stroke.buf = []; } };
  marksCanvas.addEventListener('pointerdown', (e) => {
    if (!pointing || e.button !== 0) return;
    marksCanvas.setPointerCapture(e.pointerId);
    down = { x: e.clientX, y: e.clientY, p: norm(e) };
  });
  marksCanvas.addEventListener('pointermove', (e) => {
    if (!down) return;
    if (!stroke && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) {
      stroke = { id: Math.random().toString(36).slice(2, 8), buf: [down.p] };
      sendT = setInterval(flush, 60);
    }
    if (stroke) stroke.buf.push(norm(e));
  });
  const up = (e) => {
    if (!down) return;
    if (stroke) { flush(); clearInterval(sendT); stroke = null; }
    else { const [x, y] = down.p; sendMark('ping', { x, y }); }
    down = null;
  };
  marksCanvas.addEventListener('pointerup', up);
  marksCanvas.addEventListener('pointercancel', up);
})();

let lastReact = 0;
function react(emoji) {
  const now = Date.now();
  if (now - lastReact < 350) return;
  lastReact = now;
  sendMark('react', emoji);
}
$('#react-bar').addEventListener('click', (e) => { const b = e.target.closest('button[data-e]'); if (b) react(b.dataset.e); });

// clipe: grava o que você está vendo (os últimos ~30–60 s) e salva em Vídeos\Telão
const clipper = new window.TelaoClipper();
function startClipper() {
  const ok = cfg.clips !== false && video.srcObject && window.TelaoClipper.pick();
  if (ok && clipper.stream !== video.srcObject) clipper.start(video.srcObject); // reconectou = stream novo
  $('#btn-clip').disabled = !ok;
  $('#btn-clip').title = ok ? 'Salvar o último meio minuto (C)' : 'Clipes indisponíveis neste PC';
}
async function takeClip() {
  if (!clipper.running) return toast('O clipe começa a gravar quando o vídeo aparece.');
  const btn = $('#btn-clip'); btn.disabled = true;
  try {
    const c = await clipper.take();
    if (!c || !c.blob.size) return toast('Ainda não deu tempo de gravar nada.');
    const file = await api.clip.save({ data: await c.blob.arrayBuffer(), ext: c.ext, who: selected });
    toastAction(`Clipe salvo (${c.seconds} s) em Vídeos\\Telão.`, 'Mostrar', () => api.clip.show(file));
  } catch (e) { toast('Não consegui salvar o clipe: ' + e.message); }
  finally { btn.disabled = false; }
}
$('#btn-clip').addEventListener('click', takeClip);

document.addEventListener('keydown', (e) => {
  if (!selected || e.target.closest('input, textarea, dialog') || e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.key === 'p' || e.key === 'P') setPointing(!pointing);
  if (e.key === 'c' || e.key === 'C') takeClip();
  if (e.key === 'Escape' && pointing) { setPointing(false); e.stopImmediatePropagation(); }
  const i = '123456'.indexOf(e.key);
  if (i >= 0) react(['😂', '🔥', '👏', '😮', '💀', '❤️'][i]);
}, true);

// esconde os controles quando o mouse fica parado
let idleT;
function wakePlayer() {
  $('#player').classList.remove('idle');
  clearTimeout(idleT); idleT = setTimeout(() => {
    // com o mouse em cima da barra, ela fica
    if ($('#player').querySelector('.ov:hover')) return wakePlayer();
    $('#player').classList.add('idle');
  }, 2500);
}
$('#player').addEventListener('mousemove', wakePlayer);
$('#player').addEventListener('mouseleave', () => { clearTimeout(idleT); idleT = setTimeout(() => $('#player').classList.add('idle'), 800); });

/* ---------- transmissão (motor próprio) ---------- */
function renderStream() {
  const st = stState.state;
  const live = st === 'ao-vivo', busy = st === 'iniciando';
  const pill = $('#st-pill'), btn = $('#btn-transmit');
  pill.className = 'pill' + (live ? ' live' : st === 'erro' ? ' bad' : busy ? ' ok' : '');
  pill.textContent = live ? 'AO VIVO' : busy ? 'Iniciando…' : st === 'erro' ? 'Erro' : 'Parado';
  btn.textContent = live || busy ? 'Parar transmissão' : 'Transmitir minha tela';
  btn.classList.toggle('danger', live || busy);
  btn.classList.toggle('primary', !(live || busy));
  show($('#btn-switch'), live);
  if (!live) { show($('#st-fps'), false); if (!busy) show($('#st-tip'), false); }
  const srcLine = $('#st-source');
  show(srcLine, (live || busy) && !!stState.source);
  srcLine.textContent = '';
  if (stState.source) {
    const chips = [
      [stState.source, 'src'], [stState.quality, ''], [stState.codec, stState.codec === 'AV1' ? 'av1' : ''],
      [stState.kbpsScale && stState.kbpsScale < 1 ? `taxa ${Math.round(stState.kbpsScale * 100)}%` : null, 'warn'],
      [stState.audioLabel ? '♪ ' + stState.audioLabel : null, 'audio'],
      [stState.privateGame ? `🔒 só a janela de ${stState.privateGame}` : null, 'priv'],
      [stState.light ? 'versão leve ligada' : null, 'warn'],
    ];
    for (const [t, c] of chips) {
      if (!t) continue;
      const sp = document.createElement('span');
      sp.className = 'chip ' + c; sp.textContent = t; sp.title = t;
      srcLine.appendChild(sp);
    }
  }
  if (!live) show($('#st-viewers'), false);
  // tela inteira sem jogo: avisa que notificações aparecem e oferece o Não perturbe do Windows
  show($('#st-privacy'), live && !!stState.wholeScreen);
  show($('#st-hint'), !live);
  $('#st-hint').textContent =
    live ? '' :
    busy ? (stState.detail || 'Iniciando…') :
    st === 'erro' ? (stState.detail || 'Erro.').split('\n')[0] :
    'Captura e compressão pela placa de vídeo — não trava em jogo.';
}
// quem está assistindo você, com uma bolinha de como está chegando para cada um
const VERDICT_UI = {
  ok: ['good', 'liso'], rede: ['bad', 'internet oscilando'], instavel: ['bad', 'internet oscilando'],
  origem: ['warn', 'seu PC mandando menos'], local: ['warn', 'PC dele sofrendo'],
};
let lastViewersKey = '';
api.stream.onViewers((list) => {
  const others = (list || []).filter((v) => !v.self);
  const box = $('#st-viewers'), ul = $('#st-viewers-list');
  show(box, stState.state === 'ao-vivo' && others.length > 0);
  const key = JSON.stringify(others);
  if (key === lastViewersKey) return;
  lastViewersKey = key;
  ul.textContent = '';
  for (const v of others) {
    const [cls, text] = v.verdict ? VERDICT_UI[v.verdict] || ['unk', ''] : ['unk', v.known ? 'medindo…' : 'Telão antigo (sem medição)'];
    const li = document.createElement('li');
    li.innerHTML = '<span class="q-dot"></span><b></b><small></small>';
    li.querySelector('.q-dot').className = 'q-dot ' + cls;
    li.querySelector('b').textContent = v.name;
    const extra = v.verdict && v.loss != null && v.loss >= 0.5 ? ` · ${v.loss}% perda` : '';
    li.querySelector('small').textContent = text + extra;
    li.title = `${v.name}: ${text}${extra}`;
    ul.appendChild(li);
  }
});
api.stream.onState((s) => {
  const was = stState.state;
  stState = s;
  renderStream();
  if (was !== 'ao-vivo' && s.state === 'ao-vivo') {
    toast('Você está ao vivo!');
    const card = $('#card-transmit');
    card.classList.remove('just-live'); void card.offsetWidth; card.classList.add('just-live');
  }
  if (s.state === 'erro') toast(String(s.detail || 'Erro').split('\n')[0], 7000);
});
api.stream.onNotice((m) => toast(m, 6000));

// FPS real: quantos quadros a captura produz e quantos saem do codificador
api.stream.onFps((f) => {
  const el = $('#st-fps');
  if (!f) { show(el, false); return; }
  const bar = (label, n) => {
    const pct = Math.max(4, Math.min(100, Math.round((n / f.target) * 100)));
    const cls = n < f.target - 6 ? 'low' : '';
    return `<span class="m ${cls}"><span class="m-l">${label}</span><span class="m-bar"><i style="width:${pct}%"></i></span><b>${n}</b></span>`;
  };
  el.innerHTML = bar('Captura', f.capFps) + bar('Envio', f.encFps)
    + `<span class="m-foot">meta ${f.target} FPS${f.autoActive ? ' · <span class="auto">ajuste automático ativo</span>' : ''}</span>`;
  if (f.auto) show($('#st-tip'), false);
  show(el, stState.state === 'ao-vivo');
  if (f.hint) showFpsTip(f.hint);
});
function showFpsTip(h) {
  const tip = $('#st-tip'), btn = $('#btn-tip');
  const last = cfg.lastStream || {};
  if (h.kind === 'capture') {
    $('#st-tip-text').textContent = `O jogo está tomando a placa de vídeo: a captura só consegue ~${h.avg} FPS, e isso aparece como engasgo para quem assiste. Em 30 FPS fica liso (é o que o Discord faz). Ou limite o FPS do jogo.`;
    btn.textContent = 'Transmitir a 30 FPS (liso)';
    btn.onclick = () => { show(tip, false); restartWith(last.quality && last.quality.startsWith('720') ? '720p60' : '1080p30'); };
  } else {
    $('#st-tip-text').textContent = `O codificador não está dando conta (~${h.avg} FPS saindo). Em 720p fica liso.`;
    btn.textContent = 'Transmitir em 720p';
    btn.onclick = () => { show(tip, false); restartWith('720p60'); };
  }
  show(tip, true);
}
async function restartWith(quality) {
  const last = cfg.lastStream || {};
  const r = await api.stream.start({ kind: last.kind, sourceName: last.sourceName, audio: last.audio || 'auto', quality });
  cfg = await api.cfg.get();
  if (!r.ok) toast(r.error, 7000); else toast('Reiniciando a transmissão com a qualidade nova…');
}

$('#btn-transmit').addEventListener('click', async () => {
  if (stState.state === 'ao-vivo' || stState.state === 'iniciando') {
    $('#btn-transmit').disabled = true;
    try { await api.stream.stop(); } finally { $('#btn-transmit').disabled = false; }
  } else openPicker();
});
$('#btn-switch').addEventListener('click', () => openPicker());

/* ---------- escolher tela / janela ---------- */
let pickSources = [], pickTab = 'screen', pickSel = null, qualities = null;
async function openPicker() {
  const dlg = $('#dlg-pick');
  pickSel = null;
  $('#btn-pick-go').disabled = true;
  if (!qualities) {
    qualities = await api.stream.qualities();
    const qs = $('#pick-quality');
    qs.textContent = '';
    for (const [k, v] of Object.entries(qualities)) if (!v.hidden) qs.add(new Option(`${v.label} · ${v.kbps / 1000} Mbps`, k));
  }
  const last = cfg.lastStream || {};
  $('#pick-quality').value = last.quality || '1080p60';
  renderUpload();
  dlg.showModal();
  $('#pick-grid').innerHTML = '<p class="muted">Carregando…</p>';
  pickSources = await api.stream.sources();
  pickTab = last.kind === 'window' && pickSources.some((s) => s.kind === 'window' && s.name === last.sourceName) ? 'window' : 'screen';
  const pre = pickSources.find((s) => s.kind === last.kind && s.name === last.sourceName);
  if (pre) pickSel = pre.id;
  renderPicker();
}
function renderPicker() {
  document.querySelectorAll('#dlg-pick .tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === pickTab));
  const grid = $('#pick-grid');
  grid.textContent = '';
  const items = pickSources.filter((s) => s.kind === pickTab);
  if (!items.length) grid.innerHTML = '<p class="muted">Nada para mostrar aqui.</p>';
  for (const s of items) {
    const b = document.createElement('button');
    b.className = 'src' + (s.id === pickSel ? ' on' : '');
    b.innerHTML = '<div class="th"></div><div class="nm"><span></span></div>';
    if (s.thumb) b.querySelector('.th').style.backgroundImage = `url("${s.thumb}")`;
    if (s.icon) { const im = document.createElement('img'); im.src = s.icon; b.querySelector('.nm').prepend(im); }
    b.querySelector('span').textContent = s.name;
    b.title = s.name;
    b.addEventListener('click', () => { pickSel = s.id; renderPicker(); });
    b.addEventListener('dblclick', () => { pickSel = s.id; goPick(); });
    grid.appendChild(b);
  }
  // opções de som dependem do que foi escolhido
  const sel = pickSources.find((s) => s.id === pickSel);
  const au = $('#pick-audio');
  const prev = au.value || (cfg.lastStream?.audio) || 'auto';
  au.textContent = '';
  if (sel?.kind === 'window') au.add(new Option('Só o som desta janela (recomendado)', 'auto'));
  else au.add(new Option('Automático: só o jogo em tela cheia (sem a voz do Discord)', 'auto'));
  au.add(new Option('Som do PC todo (menos o Telão)', 'pc'));
  for (const w of pickSources.filter((x) => x.kind === 'window' && x.id !== sel?.id)) au.add(new Option(`Só o som de: ${w.name.slice(0, 50)}`, 'app:' + w.id));
  au.add(new Option('Sem som', 'none'));
  au.value = [...au.options].some((o) => o.value === prev) ? prev : 'auto';
  $('#btn-pick-go').disabled = !sel;
}
function renderUpload() {
  const k = $('#pick-quality').value;
  $('#pick-upload').textContent = qualities?.[k] ? `${qualities[k].kbps / 1000} Mbps` : '';
}
document.querySelectorAll('#dlg-pick .tab').forEach((t) => t.addEventListener('click', () => { pickTab = t.dataset.tab; renderPicker(); }));
$('#pick-quality').addEventListener('change', renderUpload);
$('#btn-pick-go').addEventListener('click', goPick);
async function goPick() {
  const sel = pickSources.find((s) => s.id === pickSel);
  if (!sel) return;
  $('#dlg-pick').close();
  const r = await api.stream.start({
    sourceId: sel.id, kind: sel.kind, sourceName: sel.name,
    audio: $('#pick-audio').value, quality: $('#pick-quality').value,
  });
  cfg = await api.cfg.get();
  if (!r.ok) toast(r.error, 7000);
}

/* ---------- host / convite ---------- */
function renderHost() {
  const pill = $('#host-pill');
  if (!cfg.hosting) { pill.className = 'pill'; pill.textContent = cfg.server || '—'; return; }
  const map = { rodando: ['ok', 'Aberta'], iniciando: ['', 'Iniciando…'], parado: ['', 'Fechada'], parando: ['', 'Fechando…'], erro: ['bad', 'Erro'] };
  const [cls, txt] = map[hostState] || ['', hostState];
  pill.className = 'pill ' + cls; pill.textContent = txt;
}
api.host.onState(({ state, detail }) => { hostState = state; renderHost(); if (detail) toast(detail, 7000); });
api.host.onLog((line) => {
  const pre = $('#host-log');
  pre.textContent = (pre.textContent + line + '\n').split('\n').slice(-200).join('\n');
});

let inviteOpts = [];
const INVITE_BASE = 'https://kaizenknt.github.io/telao/#';
function setInviteCode(code) {
  const ok = /^TELAO-/.test(code || '');
  $('#invite-code').textContent = ok ? code : '…';
  $('#invite-link').textContent = ok ? INVITE_BASE + code : code;
}
async function openInvite() {
  const dlg = $('#dlg-invite');
  const code = $('#invite-code');
  show(dlg.querySelector('.help'), cfg.hosting);
  show($('#invite-via-wrap'), false); show($('#invite-via-hint'), false);
  dlg.showModal();
  if (!cfg.hosting) { setInviteCode(await api.host.inviteFor(cfg.server)); return; }
  setInviteCode('Descobrindo seus endereços…');
  const r = await api.host.invite();
  inviteOpts = r.options || [];
  if (!inviteOpts.length) { setInviteCode('Não consegui descobrir seu IP. Use o campo do Hamachi/Tailscale abaixo.'); return; }
  const sel = $('#invite-via');
  sel.textContent = '';
  inviteOpts.forEach((o, i) => sel.add(new Option(o.label + (i === 0 && o.kind !== 'internet' ? ' (recomendado)' : ''), String(i))));
  sel.value = '0';
  show($('#invite-via-wrap'), inviteOpts.length > 1);
  renderInviteVia();
}
function renderInviteVia(userPicked) {
  const o = inviteOpts[+$('#invite-via').value || 0];
  if (!o) return;
  setInviteCode(o.invite);
  const hint = $('#invite-via-hint');
  hint.textContent = o.kind === 'internet'
    ? 'Esse endereço só funciona se as portas estiverem abertas no seu roteador.'
    : `Seus amigos precisam estar na mesma rede do ${o.kind} que você.`;
  if (o.kind === 'internet' && o.portsOk) hint.textContent = 'O Telão abriu as portas no seu roteador sozinho. Seus amigos não precisam instalar nada além do Telão.';
  if (o.kind === 'internet' && o.cgnat) hint.textContent = 'Sua operadora usa CGNAT: ninguém de fora consegue chegar por esse endereço. Use uma VPN (Radmin/Tailscale) ou peça IP público à operadora.';
  show(hint, true);
  // guarda a VPN que o host escolheu, para virar a recomendada da próxima vez
  if (userPicked) api.host.remember(o.kind);
}
$('#invite-via').addEventListener('change', () => renderInviteVia(true));
$('#btn-invite').addEventListener('click', openInvite);
$('#btn-copy-invite').addEventListener('click', async () => {
  const t = $('#invite-code').textContent;
  if (!t.startsWith('TELAO-')) return;
  await api.util.copy(`Entra na minha sala do Telão: ${INVITE_BASE}${t}`); toast('Link copiado. Manda no grupo!');
});
$('#btn-copy-code').addEventListener('click', async () => {
  const t = $('#invite-code').textContent;
  if (!t.startsWith('TELAO-')) return;
  await api.util.copy(t); toast('Código copiado.');
});
$('#btn-invite-host').addEventListener('click', async () => {
  const h = $('#invite-host').value.trim();
  if (!h) return;
  setInviteCode(await api.host.inviteFor(h));
});

/* ---------- configurações ---------- */
const form = $('#settings-form');
function syncModeFields() {
  const host = form.mode.value === 'host';
  document.querySelectorAll('.guest-only').forEach((el) => show(el, !host));
  document.querySelectorAll('.host-only').forEach((el) => show(el, host));
}
$('#btn-settings').addEventListener('click', async () => {
  form.name.value = cfg.name;
  form.mode.value = cfg.hosting ? 'host' : 'guest';
  form.server.value = cfg.server || '';
  form.password.value = cfg.password || '';
  form.invite.value = '';
  $('#engine-info').textContent = cfg.encoder?.label ? `Codificador: ${cfg.encoder.label}` : 'Codificador: detectado na primeira transmissão (ou em "Testar motor").';
  form.closeToTray.checked = !!cfg.closeToTray;
  form.notifyLive.checked = !!cfg.notifyLive;
  form.autoFps.checked = cfg.autoFps !== false;
  form.privateCapture.checked = cfg.privateCapture !== false;
  form.clips.checked = cfg.clips !== false;
  form.marksOverlay.checked = cfg.marksOverlay !== false;
  form.autoWatch.checked = cfg.autoWatch !== false;
  form.startWithWindows.checked = !!cfg.startWithWindows;
  show($('#settings-error'), false);
  syncModeFields();
  const st = await api.host.status();
  $('#host-log').textContent = st.log.join('\n');
  $('#dlg-settings').showModal();
});
form.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', syncModeFields));
$('#btn-pass-show').addEventListener('click', () => {
  form.password.type = form.password.type === 'password' ? 'text' : 'password';
});
$('#btn-pass-gen').addEventListener('click', () => { form.password.value = genPassword(); form.password.type = 'text'; });
form.invite.addEventListener('input', async () => {
  const inv = await api.invite.read(form.invite.value);
  if (inv) { form.mode.value = 'guest'; syncModeFields(); form.server.value = inv.server; form.password.value = inv.password; }
});
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const host = form.mode.value === 'host';
  const err = $('#settings-error');
  if (!host && !form.server.value.trim()) { err.textContent = 'Informe o endereço do host ou cole um convite.'; show(err); return; }
  const oldPath = cfg.path;
  cfg = await api.cfg.set({
    name: form.name.value.trim(), hosting: host, server: form.server.value.trim(),
    password: form.password.value,
    closeToTray: form.closeToTray.checked, notifyLive: form.notifyLive.checked, autoFps: form.autoFps.checked,
    privateCapture: form.privateCapture.checked, clips: form.clips.checked, marksOverlay: form.marksOverlay.checked, autoWatch: form.autoWatch.checked, startWithWindows: form.startWithWindows.checked,
  });
  $('#dlg-settings').close();
  renderMe(); renderHost();
  if (oldPath !== cfg.path && stState.state === 'ao-vivo') toast('Nome trocado: pare e comece a transmissão de novo para valer.');
  if (selected) closePlayer();
  poll();
});

$('#btn-diag').addEventListener('click', async () => {
  const b = $('#btn-diag'), out = $('#diag-out');
  b.disabled = true; b.textContent = 'Testando… (até 1 min)';
  show(out); out.textContent = 'Testando captura, som e codificadores da placa de vídeo…';
  try {
    out.textContent = await api.stream.diagnose();
    show($('#btn-diag-copy'));
    cfg = await api.cfg.get();
    $('#engine-info').textContent = cfg.encoder?.label ? `Codificador: ${cfg.encoder.label}` : 'Nenhum codificador funcionou.';
  } finally { b.disabled = false; b.textContent = 'Testar motor'; }
});
$('#btn-diag-copy').addEventListener('click', async () => { await api.util.copy($('#diag-out').textContent); toast('Relatório copiado. Cola na conversa comigo!'); });
$('#btn-log').addEventListener('click', () => api.stream.openLog());

/* ---------- Portas no roteador (UPnP) ---------- */
function renderNet(st) {
  const el = $('#host-net');
  if (!cfg.hosting || !st || st.status === 'idle') return show(el, false);
  const map = {
    working: 'Abrindo as portas no roteador…',
    ok: '✔ Portas abertas no roteador pelo Telão — amigos podem entrar pela internet, sem VPN.',
    partial: `⚠ Abri quase tudo, mas ${(st.conflicts || []).join(', ')} já está em uso por outro aparelho da casa.`,
    unavailable: 'Não consegui abrir as portas sozinho (UPnP desligado no roteador). Use uma VPN ou abra manualmente.',
    error: 'Não consegui abrir as portas sozinho: ' + (st.error || ''),
  };
  let t = map[st.status] || '';
  if (st.cgnat) t = '⚠ Sua operadora usa CGNAT: abrir portas não adianta. Use o Radmin/Tailscale ou peça IP público à operadora.';
  el.textContent = t;
  show(el, !!t);
}
api.net.onState(renderNet);

/* ---------- Firewall ---------- */
let fwState = null;
function renderFw() {
  const bad = fwState && !fwState.ok;
  show($('#bn-fw'), !!bad);
  $('#fw-info').textContent = !fwState ? 'Firewall: verificando…' : fwState.ok ? 'Firewall: liberado ✔' : 'Firewall: bloqueando o Telão';
}
async function fixFirewall(btn) {
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = 'Clique em "Sim" no aviso do Windows…';
  try {
    const r = await api.fw.fix();
    toast(r.ok ? 'Firewall liberado! Seus amigos já podem conectar.' : r.error, 6000);
    fwState = await api.fw.status(); renderFw();
  } finally { btn.disabled = false; btn.textContent = old; }
}
$('#btn-fw').addEventListener('click', (e) => fixFirewall(e.currentTarget));
$('#btn-fw2').addEventListener('click', (e) => fixFirewall(e.currentTarget));
api.fw.onState((s) => { fwState = s; renderFw(); });
async function checkFw() { fwState = await api.fw.status(); renderFw(); }

/* ---------- Atualização ---------- */
let updState = null;
function renderUpd() {
  const s = updState || {};
  $('#ver-info').textContent = `Telão ${s.version || ''}` + (s.state === 'up-to-date' ? ' · atualizado ✔' : s.state === 'checking' ? ' · procurando…' : s.state === 'downloading' ? ` · baixando ${s.latest}…` : '');
  const bn = $('#bn-upd'), btn = $('#btn-upd');
  if (s.state === 'ready') {
    $('#bn-upd-text').innerHTML = `<b>Versão ${s.latest} baixada.</b> Reinicie o Telão para usar.`;
    btn.textContent = 'Reiniciar agora'; btn.onclick = () => api.upd.relaunch(); show(bn, true);
  } else if (s.state === 'needs-full') {
    $('#bn-upd-text').innerHTML = `<b>Versão ${s.latest} disponível.</b> Essa precisa baixar o pacote completo.`;
    btn.textContent = 'Abrir download'; btn.onclick = () => api.util.open(s.url); show(bn, true);
  } else show(bn, false);
}
api.upd.onState((s) => { updState = s; renderUpd(); });
$('#btn-upd-check').addEventListener('click', async () => { updState = await api.upd.check(); updState = await api.upd.state(); renderUpd(); });

document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

/* ---------- convite aberto por link ---------- */
async function handleInvite(code) {
  if (!code) return;
  const inv = await api.invite.read(code);
  if (!inv) return toast('Esse link de convite não é válido.');
  // primeira vez: só preenche o convite no cadastro
  if (!$('#onboarding').classList.contains('hidden') || !cfg.name) {
    const guest = document.querySelector('.choice[data-mode=guest]');
    if (guest) guest.click();
    $('#ob-invite').value = code; $('#ob-invite').dispatchEvent(new Event('input'));
    $('#ob-name').focus();
    return toast('Convite carregado. Coloque seu nome e clique em "Entrar na sala".');
  }
  if (!cfg.hosting && cfg.server === inv.server && cfg.password === inv.password) return toast('Você já está nessa sala.');
  $('#join-text').textContent = `Entrar na sala em ${inv.server}?`;
  const warn = cfg.hosting ? 'A sala que está aberta neste PC vai fechar (seus amigos saem dela).'
    : stState.state === 'ao-vivo' ? 'Sua transmissão atual vai parar.' : '';
  $('#join-warn').textContent = warn; show($('#join-warn'), !!warn);
  $('#btn-join').onclick = async () => {
    $('#dlg-join').close();
    if (stState.state === 'ao-vivo' || stState.state === 'iniciando') await api.stream.stop();
    cfg = await api.cfg.set({ hosting: false, server: inv.server, password: inv.password });
    location.reload();
  };
  $('#dlg-join').showModal();
}
api.invite.onOpen((code) => handleInvite(code));

/* ---------- início ---------- */
(async () => {
  cfg = await api.cfg.get();
  const st = await api.host.status();
  hostState = st.state;
  if (!cfg.name || !cfg.password || (!cfg.hosting && !cfg.server)) setupOnboarding();
  else startApp();
  handleInvite(await api.invite.pending());
})();
