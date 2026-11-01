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
  }
  renderStreams();
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
  // a transmissão que eu assistia acabou
  if (selected && lastPollOk && !streams.find((s) => s.name === selected)) {
    $('#loading-text').textContent = `${selected} parou de transmitir. Esperando voltar…`;
  }
}

/* ---------- player ---------- */
const video = $('#video');
const player = new WhepPlayer(video, {
  onStatus: ({ state, why }) => {
    if (state === 'playing') { show($('#loading'), false); return; }
    show($('#loading'));
    $('#loading-text').textContent =
      state === 'connecting' ? 'Conectando…' :
      state === 'reconnecting' && /não começou/.test(why) ? `${selected} não está transmitindo. Esperando voltar…` :
      state === 'reconnecting' ? `Reconectando (${why})…` :
      why || 'Erro';
  },
  onStats: (s) => {
    const parts = [];
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

async function watch(name) {
  goneCount = 0;
  selected = name;
  show($('#stage-empty'), false);
  show($('#player'));
  $('#who').textContent = name;
  // assistindo a si mesmo: começa mudo para não dar eco
  video.muted = name === cfg.path; renderVol();
  renderStreams();
  const host = await api.serverHost();
  const auth = await api.authHeader();
  player.play(`http://${host}:${cfg.ports.webrtc}/${encodeURIComponent(name)}/whep`, auth);
}

function closePlayer() {
  selected = null;
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
// esconde os controles quando o mouse fica parado
let idleT;
$('#player').addEventListener('mousemove', () => {
  $('#player').classList.remove('idle');
  clearTimeout(idleT); idleT = setTimeout(() => $('#player').classList.add('idle'), 2500);
});

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
  srcLine.textContent = stState.source ? `${stState.source} · ${stState.quality || ''}${stState.encoder ? ' · ' + stState.encoder : ''}` : '';
  $('#st-hint').textContent =
    live ? `Você está ao vivo como “${cfg.path}”.` :
    busy ? (stState.detail || 'Iniciando…') :
    st === 'erro' ? (stState.detail || 'Erro.').split('\n')[0] :
    'Captura e compressão pela placa de vídeo — não trava em jogo.';
}
api.stream.onState((s) => {
  const was = stState.state;
  stState = s;
  renderStream();
  if (was !== 'ao-vivo' && s.state === 'ao-vivo') toast('Você está ao vivo!');
  if (s.state === 'erro') toast(String(s.detail || 'Erro').split('\n')[0], 7000);
});
api.stream.onNotice((m) => toast(m, 6000));

// FPS real: quantos quadros a captura produz e quantos saem do codificador
api.stream.onFps((f) => {
  const el = $('#st-fps');
  if (!f) { show(el, false); return; }
  const low = (n) => (n < f.target - 6 ? ' class="low"' : '');
  el.innerHTML = `capturando <b${low(f.capFps)}>${f.capFps}</b> · enviando <b${low(f.encFps)}>${f.encFps}</b> de ${f.target} FPS`
    + (f.autoActive ? ' · <span class="auto">ajuste automático</span>' : '');
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
  else au.add(new Option('Som do PC todo (menos o Telão)', 'auto'));
  if (sel?.kind === 'window') au.add(new Option('Som do PC todo (menos o Telão)', 'pc'));
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
async function openInvite() {
  const dlg = $('#dlg-invite');
  const code = $('#invite-code');
  show(dlg.querySelector('.help'), cfg.hosting);
  show($('#invite-via-wrap'), false); show($('#invite-via-hint'), false);
  dlg.showModal();
  if (!cfg.hosting) { code.textContent = await api.host.inviteFor(cfg.server); return; }
  code.textContent = 'Descobrindo seus endereços…';
  const r = await api.host.invite();
  inviteOpts = r.options || [];
  if (!inviteOpts.length) { code.textContent = 'Não consegui descobrir seu IP. Use o campo do Hamachi/Tailscale abaixo.'; return; }
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
  $('#invite-code').textContent = o.invite;
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
  await api.util.copy(t); toast('Convite copiado. Manda no grupo!');
});
$('#btn-invite-host').addEventListener('click', async () => {
  const h = $('#invite-host').value.trim();
  if (!h) return;
  $('#invite-code').textContent = await api.host.inviteFor(h);
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
    closeToTray: form.closeToTray.checked, notifyLive: form.notifyLive.checked, autoFps: form.autoFps.checked, startWithWindows: form.startWithWindows.checked,
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

/* ---------- início ---------- */
(async () => {
  cfg = await api.cfg.get();
  const st = await api.host.status();
  hostState = st.state;
  if (!cfg.name || !cfg.password || (!cfg.hosting && !cfg.server)) setupOnboarding();
  else startApp();
})();
