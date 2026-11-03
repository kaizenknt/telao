// Telão — processo principal (Electron)
// Atualização automática: usa a versão de código mais nova que estiver instalada
// (a que veio no app, a de resources/update ou a baixada do GitHub em %AppData%\Telao\update).
{
  const _p = require('path'), _fs = require('fs');
  if (!global.__telaoLoaded) {
    global.__telaoLoaded = true;
    const ver = (dir) => { try { return require(_p.join(dir, 'version.js')).VERSION; } catch { return '0.0.0'; } };
    const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
    const appData = process.env.APPDATA || _p.join(require('os').homedir(), '.config');
    const cands = [_p.join(appData, 'Telao', 'update', 'src'), _p.join(process.resourcesPath || '', 'update', 'src')]
      .filter((d) => d !== __dirname && _fs.existsSync(_p.join(d, 'main.js')));
    let best = null, bestV = ver(__dirname);
    for (const d of cands) { const v = ver(d); if (cmp(v, bestV) > 0) { best = d; bestV = v; } }
    if (best) { require(_p.join(best, 'main.js')); return; }
  }
}
const { app, BrowserWindow, ipcMain, shell, clipboard, protocol, net, session, Tray, Menu, Notification, nativeImage } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const createEngine = require('./engine');
const sys = require('./system');
const { createUpnp } = require('./upnp');
const { createRoomProxy } = require('./roomproxy');

const PORTS = { webrtc: 8889, ice: 8189, api: 9997, apiInner: 9996 }; // 9997 = porteiro (roomproxy), 9996 = API do MediaMTX só por dentro
const ROOM_USER = 'sala';

let win = null;
let quitting = false;
const send = (ch, data) => {
  if (win && !win.isDestroyed()) win.webContents.send(ch, data);
  if (ch === 'stream:state' || ch === 'host:state') updateTray();
  // janela fechada (modo leve): avisos importantes viram notificação do Windows
  if (!win && ch === 'stream:state' && data?.state === 'erro') notify('A transmissão parou', String(data.detail || '').split('\n')[0]);
  if (!win && ch === 'stream:state' && data?.state === 'ao-vivo') notify('Você está ao vivo', data.source ? `Transmitindo: ${data.source}` : '');
  if (!win && ch === 'stream:notice') notify('Telão', String(data));
};

/* ---------------- Configurações ---------------- */
const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
const DEFAULTS = {
  name: '', server: '', password: '', hosting: false, encoder: null, encoderGst: null, lastStream: null,
  closeToTray: true, startWithWindows: false, notifyLive: true, trayHintShown: false,
  preferVpn: null,
  autoFps: true,
  codecPref: 'auto', // 'auto' = AV1 quando todos que assistem abrem; 'h264' = sempre H.264
  av1Bad: false,     // este PC já mostrou que não dá conta de abrir AV1 // troca sozinho para menos FPS/resolução quando o jogo ou o codificador não dá conta (igual o Discord) // VPN que o host escolheu por último para os convites (ex.: "Hamachi")
};
function loadCfg() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(cfgFile(), 'utf8')) }; }
  catch { return { ...DEFAULTS }; }
}
function saveCfg(c) {
  fs.mkdirSync(path.dirname(cfgFile()), { recursive: true });
  fs.writeFileSync(cfgFile(), JSON.stringify(c, null, 2));
  return c;
}
let cfg = null;

const cleanHost = (h) => String(h || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
const slug = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'anonimo';
const serverHost = () => (cfg.hosting ? '127.0.0.1' : cleanHost(cfg.server));
const basicAuth = () => 'Basic ' + Buffer.from(`${ROOM_USER}:${cfg.password}`).toString('base64');

/* ---------------- Servidor (modo host) ---------------- */
let mtx = null;
let mtxLog = [];
let mtxState = 'parado'; // parado | iniciando | rodando | erro

function mediamtxBin() {
  if (process.env.MEDIAMTX_BIN) return process.env.MEDIAMTX_BIN; // para testes fora do Windows
  const base = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(__dirname, '..', 'resources', 'bin');
  return path.join(base, process.platform === 'win32' ? 'mediamtx.exe' : 'mediamtx');
}

function yamlStr(s) { return JSON.stringify(String(s)); } // string JSON é YAML válido

let advertiseHosts = []; // IP público anunciado aos amigos (vem do UPnP)
function buildMtxConfig(password) {
  return `# Gerado pelo Telão — não edite, é recriado a cada início.
logLevel: info
logDestinations: [stdout]

authMethod: internal
authInternalUsers:
  - user: ${ROOM_USER}
    pass: ${yamlStr(password)}
    ips: []
    permissions:
      - action: publish
      - action: read
      - action: api

api: true
apiAddress: 127.0.0.1:${PORTS.apiInner}
apiAllowOrigins: ["*"]

rtsp: false
rtmp: false
hls: false
srt: false
moq: false

webrtc: true
webrtcAddress: :${PORTS.webrtc}
webrtcAllowOrigins: ["*"]
webrtcLocalUDPAddress: :${PORTS.ice}
webrtcLocalTCPAddress: :${PORTS.ice}
webrtcIPsFromInterfaces: true
webrtcAdditionalHosts: ${JSON.stringify(advertiseHosts)}
webrtcICEServers2:
  - url: stun:stun.l.google.com:19302

paths:
  all_others:
`;
}

function setMtxState(s, detail) { mtxState = s; send('host:state', { state: s, detail }); }

// porteiro da sala na porta 9997: repassa a API e guarda os relatos de quem assiste
const roomProxy = createRoomProxy({ listenPort: PORTS.api, targetPort: PORTS.apiInner, user: ROOM_USER, getPassword: () => cfg.password,
  log: (m) => { mtxLog.push(m); if (mtxLog.length > 300) mtxLog.shift(); send('host:log', m); } });
let proxyOn = false;

function startHost() {
  if (mtx) return { ok: true };
  if (!proxyOn) {
    proxyOn = true;
    roomProxy.start().catch((e) => {
      proxyOn = false;
      setMtxState('erro', /EADDRINUSE/.test(e.code || e.message) ? 'A porta 9997 já está em uso. Feche outro Telão/MediaMTX aberto.' : 'Porteiro da sala: ' + e.message);
    });
  }
  if (!cfg.password) return { ok: false, error: 'Defina uma senha para a sala primeiro.' };
  const bin = mediamtxBin();
  if (!fs.existsSync(bin)) return { ok: false, error: 'Servidor não encontrado em ' + bin };
  const dir = path.join(app.getPath('userData'), 'servidor');
  fs.mkdirSync(dir, { recursive: true });
  const conf = path.join(dir, 'mediamtx.yml');
  fs.writeFileSync(conf, buildMtxConfig(cfg.password));
  mtxLog = [];
  setMtxState('iniciando');
  mtx = spawn(bin, [conf], { cwd: dir, windowsHide: true });
  const onData = (buf) => {
    for (const line of buf.toString().split(/\r?\n/).filter(Boolean)) {
      mtxLog.push(line); if (mtxLog.length > 300) mtxLog.shift();
      send('host:log', line);
      if (/\[API\] started/.test(line)) { setMtxState('rodando'); openPorts(); }
      if (/address already in use|bind:|Only one usage of each socket address/i.test(line))
        setMtxState('erro', 'Uma porta (8889, 8189, 9996 ou 9997) já está em uso. Feche outro Telão/MediaMTX aberto.');
    }
  };
  mtx.stdout.on('data', onData);
  mtx.stderr.on('data', onData);
  mtx.on('exit', (code) => {
    mtx = null;
    if (mtxState !== 'erro' && mtxState !== 'parando') setMtxState(code === 0 || code === null ? 'parado' : 'erro', code ? `Servidor fechou (código ${code}).` : undefined);
  });
  return { ok: true };
}

function stopHost() {
  if (!mtx) return Promise.resolve();
  const proc = mtx;
  mtxState = 'parando';
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(done, 3000);
    proc.once('exit', done);
    try { proc.kill(); } catch { done(); }
  }).then(async () => {
    mtx = null; setMtxState('parado');
    if (proxyOn && !cfg.hosting) { proxyOn = false; await roomProxy.stop(); }
  });
}

/* ---------------- Portas no roteador (UPnP) ---------------- */
const upnp = createUpnp({
  ports: [
    { port: PORTS.webrtc, protocol: 'TCP' }, { port: PORTS.api, protocol: 'TCP' },
    { port: PORTS.ice, protocol: 'TCP' }, { port: PORTS.ice, protocol: 'UDP' },
  ],
  log: (m) => { mtxLog.push(m); if (mtxLog.length > 300) mtxLog.shift(); send('host:log', m); },
});
let netState = { status: 'idle' };
let upnpBusy = null;
let upnpRetryTimer = null, upnpRetryMs = 30000;
function openPorts() {
  if (upnpBusy || !cfg.hosting) return upnpBusy;
  netState = { status: 'working' }; send('net:state', netState);
  clearTimeout(upnpRetryTimer);
  upnpBusy = upnp.open().then(async (st) => {
    upnpBusy = null;
    netState = st; send('net:state', netState);
    // roteador não respondeu (às vezes ainda está ligando, ou perdeu o pacote): tenta de novo sozinho
    if (['unavailable', 'error'].includes(st.status) && cfg.hosting) {
      upnpRetryTimer = setTimeout(openPorts, upnpRetryMs);
      upnpRetryMs = Math.min(upnpRetryMs * 2, 10 * 60 * 1000);
    } else upnpRetryMs = 30000;
    // com IP público de verdade, o servidor passa a anunciá-lo (ajuda o vídeo a chegar direto)
    const ext = st.externalIp;
    if (['ok', 'partial'].includes(st.status) && ext && !st.cgnat && !advertiseHosts.includes(ext) && mtx) {
      advertiseHosts = [ext];
      await stopHost(); startHost(); // reinicia uma vez, só quando o IP muda
    }
    return st;
  });
  return upnpBusy;
}

async function publicIp() {
  for (const url of ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com']) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
      const t = (await r.text()).trim();
      if (/^[0-9a-f.:]+$/i.test(t)) return t;
    } catch {}
  }
  return null;
}

function makeInvite(host) {
  const payload = Buffer.from(JSON.stringify({ h: host, p: cfg.password })).toString('base64url');
  return 'TELAO-' + payload;
}
function readInvite(code) {
  const m = String(code || '').trim().match(/^TELAO-([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  try {
    const o = JSON.parse(Buffer.from(m[1], 'base64url').toString());
    return o.h && o.p ? { server: cleanHost(o.h), password: String(o.p) } : null;
  } catch { return null; }
}

/* ---------------- Lista de transmissões ---------------- */
async function listRooms() {
  const host = serverHost();
  if (!host || !cfg.password) return { ok: false, error: 'Sem servidor configurado.' };
  try {
    const r = await fetch(`http://${host}:${PORTS.api}/v3/paths/list?itemsPerPage=100`, {
      headers: { Authorization: basicAuth() }, signal: AbortSignal.timeout(4000),
    });
    if (r.status === 401) return { ok: false, error: 'Senha da sala incorreta.' };
    if (!r.ok) return { ok: false, error: `Servidor respondeu ${r.status}.` };
    const j = await r.json();
    const items = (j.items || []).filter((p) => p.online ?? p.ready).map((p) => ({
      name: p.name,
      since: p.onlineTime || p.readyTime || null,
      viewers: (p.readers || []).length,
      bytes: p.inboundBytes ?? p.bytesReceived ?? 0,
      tracks: (p.tracks2 || p.tracks || []).map((t) => (typeof t === 'string' ? t : t.codec)),
    }));
    return { ok: true, items };
  } catch (e) {
    return { ok: false, error: 'Não consegui falar com o servidor (' + (e.cause?.code || e.name) + ').' };
  }
}

/* ---------------- Motor de captura ---------------- */
async function apiFetch(apiPath, method = 'GET') {
  const r = await fetch(`http://${serverHost()}:${PORTS.api}${apiPath}`, {
    method, headers: { Authorization: basicAuth() }, signal: AbortSignal.timeout(4000),
  });
  if (!r.ok) return null;
  const t = await r.text();
  try { return JSON.parse(t); } catch { return {}; }
}
let engine = null; // criado quando o app fica pronto

/* ---------------- Atualização ---------------- */
const resDir = () => (app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'resources'));
const updater = sys.createUpdater({
  onState: (st) => {
    send('upd:state', { ...st, version: sys.VERSION });
    if (!win && st.state === 'ready') notify('Telão atualizado', `Versão ${st.latest} pronta. Abra o Telão e clique em "Reiniciar".`);
  },
});

/* ---------------- IPC ---------------- */
function registerIpc() {
  ipcMain.handle('cfg:get', () => ({ ...cfg, path: slug(cfg.name), ports: PORTS }));
  ipcMain.handle('cfg:set', async (_e, patch) => {
    const wasHosting = cfg.hosting;
    const oldPass = cfg.password;
    cfg = saveCfg({ ...cfg, ...patch, server: patch.server !== undefined ? cleanHost(patch.server) : cfg.server });
    if (wasHosting && (!cfg.hosting || cfg.password !== oldPass)) await stopHost();
    if (wasHosting && !cfg.hosting) { upnp.close().catch(() => {}); netState = { status: 'idle' }; send('net:state', netState); }
    if (cfg.hosting && !mtx) startHost();
    applyLoginItem();
    updateTray();
    return { ...cfg, path: slug(cfg.name), ports: PORTS };
  });
  ipcMain.handle('invite:read', (_e, code) => readInvite(String(code || '').trim().replace(/^.*#(TELAO-)/, '$1')));
  ipcMain.handle('invite:pending', () => { const c = pendingInvite; pendingInvite = null; return c; });
  // quem assiste manda para a sala como está chegando (o porteiro da sala guarda; quem transmite lê)
  ipcMain.handle('rooms:feedback', async (_e, fb) => {
    try {
      const r = await fetch(`http://${serverHost()}:${PORTS.api}/telao/fb`, {
        method: 'POST', headers: { Authorization: basicAuth(), 'Content-Type': 'application/json' },
        body: JSON.stringify(fb), signal: AbortSignal.timeout(3000),
      });
      return r.ok;
    } catch { return false; }
  });
  ipcMain.handle('auth:header', () => basicAuth());
  ipcMain.handle('server:host', () => serverHost());

  ipcMain.handle('host:start', () => startHost());
  ipcMain.handle('host:stop', async () => { await stopHost(); return { ok: true }; });
  ipcMain.handle('host:status', () => ({ state: mtxState, log: mtxLog.slice(-80) }));
  ipcMain.handle('host:invite', async () => {
    // opções de endereço: redes virtuais primeiro (não precisam abrir porta), depois o IP da internet
    const opts = sys.vpnAddresses().map((v) => ({ label: `${v.kind} · ${v.ip}`, host: v.ip, kind: v.kind, invite: makeInvite(v.ip) }));
    const ip = (netState.externalIp && !netState.cgnat ? netState.externalIp : null) || await publicIp();
    const portsOk = ['ok', 'partial'].includes(netState.status) && !netState.cgnat;
    if (ip) {
      const note = netState.cgnat ? 'sua operadora usa CGNAT, não funciona' : portsOk ? 'portas abertas pelo Telão ✔' : 'precisa abrir portas';
      const o = { label: `Internet · ${ip} (${note})`, host: ip, kind: 'internet', invite: makeInvite(ip), portsOk, cgnat: !!netState.cgnat };
      // sem preferência salva e com as portas abertas, a internet direta é a melhor opção
      if (portsOk && !cfg.preferVpn) opts.unshift(o); else opts.push(o);
    }
    // se o host já escolheu uma VPN antes, ela vira a primeira (recomendada)
    if (cfg.preferVpn) {
      const i = opts.findIndex((o) => o.kind === cfg.preferVpn);
      if (i > 0) opts.unshift(opts.splice(i, 1)[0]);
    }
    return { options: opts, ports: PORTS };
  });
  ipcMain.handle('host:inviteFor', (_e, host) => makeInvite(cleanHost(host)));
  ipcMain.handle('invite:remember', (_e, kind) => {
    if (kind && cfg.preferVpn !== kind) cfg = saveCfg({ ...cfg, preferVpn: kind });
  });
  ipcMain.handle('net:state', () => netState);
  ipcMain.handle('net:retry', () => openPorts());

  ipcMain.handle('rooms:list', () => listRooms());

  ipcMain.handle('stream:sources', () => engine.sources());
  ipcMain.handle('stream:start', (_e, opts) => engine.start(opts || {}));
  ipcMain.handle('stream:stop', () => engine.stop());
  ipcMain.handle('stream:state', () => engine.state());
  ipcMain.handle('stream:qualities', () => engine.QUALITY);
  ipcMain.handle('stream:diagnose', () => engine.diagnose());
  ipcMain.handle('stream:openLog', () => shell.showItemInFolder(engine.logPath));

  ipcMain.handle('fw:status', () => sys.firewallStatus(resDir()));
  ipcMain.handle('fw:fix', async () => { const r = await sys.firewallFix(resDir()); send('fw:state', await sys.firewallStatus(resDir())); return r; });
  ipcMain.handle('upd:state', () => ({ ...updater.state(), version: sys.VERSION }));
  ipcMain.handle('upd:check', () => updater.check());
  ipcMain.handle('upd:relaunch', () => { engine?.stop(true); stopHost(); updater.relaunch(); });

  ipcMain.handle('util:copy', (_e, t) => { clipboard.writeText(String(t)); return true; });
  ipcMain.handle('util:open', (_e, url) => { if (/^https:\/\/github\.com\//.test(url)) shell.openExternal(url); });
  ipcMain.handle('win:fullscreen', (_e, on) => { if (win) win.setFullScreen(!!on); return win?.isFullScreen(); });
}

/* ---------------- Janela ---------------- */
const asset = (f) => path.join(__dirname, 'assets', f);

function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 820, minWidth: 900, minHeight: 600,
    backgroundColor: '#0e0d0c',
    title: 'Telão',
    icon: asset(process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.loadURL('app://telao/index.html');
  win.on('leave-full-screen', () => send('win:fullscreen', false));
  win.on('enter-full-screen', () => send('win:fullscreen', true));
  win.on('close', () => {
    // Modo leve: a janela é destruída de verdade (libera RAM e placa de vídeo),
    // mas a sala e a transmissão continuam rodando pela bandeja.
    if (!quitting && cfg.closeToTray && !cfg.trayHintShown) {
      cfg = saveCfg({ ...cfg, trayHintShown: true });
      notify('O Telão continua aberto', 'Ele fica aqui na bandeja, perto do relógio, gastando quase nada. Clique no ícone para abrir.');
    }
  });
  win.on('closed', () => { win = null; updateTray(); });
}

// Abre (ou recria) a janela; opcionalmente já assistindo alguém
function showWindow(watchName) {
  if (!win) {
    createWindow();
    if (watchName) win.webContents.once('did-finish-load', () => setTimeout(() => send('ui:watch', watchName), 600));
  } else {
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
    if (watchName) send('ui:watch', watchName);
  }
}

/* ---------------- Bandeja (modo leve) ---------------- */
let tray = null;
let liveNow = [];            // quem está ao vivo (último poll)
let knownLive = null;        // para avisar só de quem acabou de entrar
let trayPollTimer = null;

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: asset('icon.png'), silent: false });
  if (onClick) n.on('click', onClick);
  n.show();
}

function createTray() {
  if (tray) return;
  tray = new Tray(nativeImage.createFromPath(asset('tray.png')));
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
  updateTray();
}

function updateTray() {
  if (!tray || !cfg) return;
  const me = slug(cfg.name);
  const others = liveNow.filter((n) => n !== me);
  const live = engine?.state().state === 'ao-vivo';
  tray.setImage(nativeImage.createFromPath(asset(live ? 'tray-live.png' : 'tray.png')));
  const sala = cfg.hosting
    ? { rodando: 'Sala aberta neste PC', iniciando: 'Abrindo a sala…', parado: 'Sala fechada', parando: 'Fechando a sala…', erro: 'Erro na sala' }[mtxState] || mtxState
    : `Sala de ${cfg.server || '—'}`;
  tray.setToolTip(['Telão', live ? 'Você está AO VIVO' : null, sala, others.length ? `${others.length} ao vivo` : null].filter(Boolean).join(' · '));

  const watchItems = others.length
    ? others.map((n) => ({ label: `Assistir ${n}`, click: () => showWindow(n) }))
    : [{ label: 'Ninguém ao vivo agora', enabled: false }];

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir o Telão', click: () => showWindow() },
    { type: 'separator' },
    engine?.isLive()
      ? { label: 'Parar minha transmissão', click: () => engine.stop() }
      : { label: cfg.lastStream ? `Transmitir (${cfg.lastStream.sourceName})` : 'Transmitir minha tela', click: async () => {
          const r = await engine.start(cfg.lastStream || {});
          if (!r.ok) notify('Não deu para transmitir', r.error);
        } },
    { type: 'separator' },
    ...watchItems,
    { type: 'separator' },
    { label: sala, enabled: false },
    { label: 'Copiar convite da sala', click: copyInviteFromTray },
    { type: 'separator' },
    { label: 'Avisar quando alguém entrar ao vivo', type: 'checkbox', checked: !!cfg.notifyLive, click: (i) => { cfg = saveCfg({ ...cfg, notifyLive: i.checked }); } },
    { label: 'Iniciar com o Windows', type: 'checkbox', checked: !!cfg.startWithWindows, click: (i) => { cfg = saveCfg({ ...cfg, startWithWindows: i.checked }); applyLoginItem(); } },
    { type: 'separator' },
    { label: 'Sair do Telão', click: () => { quitting = true; app.quit(); } },
  ]));
}

async function copyInviteFromTray() {
  let code;
  if (cfg.hosting) {
    const ip = await publicIp();
    if (!ip) return notify('Não consegui seu IP', 'Abra o Telão e use "Convidar amigos" com o IP do Hamachi/Tailscale.');
    code = makeInvite(ip);
  } else code = makeInvite(cleanHost(cfg.server));
  clipboard.writeText(code);
  notify('Convite copiado', 'É só colar no grupo dos amigos.');
}

// Poll leve em segundo plano (só na bandeja): mantém a lista do menu e avisa quem entrou ao vivo.
async function trayPoll() {
  if (!cfg || !cfg.password || (!cfg.hosting && !cfg.server)) return;
  const r = await listRooms();
  if (!r.ok) return;
  liveNow = r.items.map((i) => i.name);
  const me = slug(cfg.name);
  if (knownLive) {
    for (const n of liveNow) {
      const isNew = !knownLive.includes(n);
      const looking = win && win.isFocused();
      if (isNew && n !== me && cfg.notifyLive && !looking) {
        notify(`${n} está ao vivo`, 'Clique para assistir.', () => showWindow(n));
      }
    }
  }
  knownLive = liveNow;
  updateTray();
}

function applyLoginItem() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: !!cfg.startWithWindows, args: ['--tray'] });
}

app.setName('Telao');
app.setPath('userData', path.join(app.getPath('appData'), 'Telao'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// A interface roda em app://telao/ (e não file://) para ter uma "origem" de verdade:
// o servidor recusa pedidos de vídeo vindos da origem "null" que o file:// usa.
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: false, supportFetchAPI: true, corsEnabled: true } }]);
if (!app.requestSingleInstanceLock()) app.quit();

/* ---------------- Convite por link (telao://entrar/TELAO-...) ----------------
 * O link do convite abre uma página no GitHub, que chama telao://entrar/<código>. O Windows entrega isso
 * para o Telão (aberto ou não), e a interface pergunta se quer entrar na sala.
 */
let pendingInvite = null;
function inviteFromArgv(argv) {
  for (const a of argv || []) {
    const m = String(a).match(/^telao:\/\/(?:entrar\/)?(TELAO-[A-Za-z0-9_-]+)/i);
    if (m) return m[1];
  }
  return null;
}
function deliverInvite(code) {
  if (!code || !readInvite(code)) return;
  pendingInvite = code;
  showWindow();
  if (win && !win.webContents.isLoading()) win.webContents.send('invite:open', code);
}
pendingInvite = inviteFromArgv(process.argv);
app.on('second-instance', (_e, argv) => {
  const code = inviteFromArgv(argv);
  if (code) deliverInvite(code); else showWindow();
});
if (process.platform === 'win32') app.setAppUserModelId('br.kaike.telao');

app.whenReady().then(() => {
  const root = path.join(__dirname, 'renderer');
  protocol.handle('app', async (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root)) return new Response('not found', { status: 404 });
    // sem cache: senão, depois de atualizar o app, a interface antiga podia continuar aparecendo
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    headers.set('Cache-Control', 'no-store');
    return new Response(res.body, { status: res.status, headers });
  });
  session.defaultSession.clearCache().catch(() => {});
  cfg = loadCfg();
  engine = createEngine({
    getCfg: () => cfg, setCfg: (patch) => { cfg = saveCfg({ ...cfg, ...patch }); },
    send, slug, serverHost, PORTS, ROOM_USER, apiFetch,
  });
  // registra o telao:// no Windows (aponta para este Telão)
  try {
    if (process.defaultApp) app.setAsDefaultProtocolClient('telao', process.execPath, [path.resolve(process.argv[1] || '.')]);
    else app.setAsDefaultProtocolClient('telao');
  } catch {}
  registerIpc();
  createTray();
  // Iniciado junto com o Windows: abre direto na bandeja, sem janela.
  const startHidden = process.argv.includes('--tray') && cfg.name && cfg.password;
  if (!startHidden) createWindow();
  if (cfg.hosting && cfg.password) startHost();
  applyLoginItem();
  trayPoll();
  trayPollTimer = setInterval(trayPoll, 5000);
  // procura atualização ao abrir e a cada 3 horas
  setTimeout(() => updater.check(), 8000);
  setInterval(() => updater.check(), 3 * 60 * 60 * 1000);
});

let cleanedUp = false;
app.on('before-quit', (e) => {
  quitting = true;
  if (cleanedUp) return;
  e.preventDefault();
  cleanedUp = true;
  clearInterval(trayPollTimer);
  engine?.stop(true);
  stopHost();
  // tira as regras do roteador antes de fechar (no máximo 2,5 s)
  Promise.race([upnp.close().catch(() => {}), new Promise((r) => setTimeout(r, 2500))]).finally(() => app.quit());
});
// Com o modo leve ligado, fechar a janela NÃO fecha o app (a sala continua). Para sair: bandeja → Sair.
app.on('window-all-closed', () => { if (quitting || !cfg?.closeToTray) app.quit(); });
