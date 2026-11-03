// Telão — motor de captura próprio (substitui o OBS).
// Usa o GStreamer embutido (resources/gst):
//   captura:   d3d11screencapturesrc (tela ou janela, direto na placa de vídeo)
//   vídeo:     NVENC / AMD AMF / Intel QSV / Media Foundation (o que o PC tiver)
//   áudio:     wasapi2src em loopback (PC todo, ou só o app compartilhado)
//   envio:     whipsink → servidor da sala (WebRTC)
const { app, desktopCapturer, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');

const QUALITY = {
  '720p30':  { w: 1280, h: 720,  fps: 30, kbps: 3500,  label: '720p · 30 FPS', hidden: true },
  '720p60':  { w: 1280, h: 720,  fps: 60, kbps: 5000,  label: '720p · 60 FPS' },
  '1080p30': { w: 1920, h: 1080, fps: 30, kbps: 6000,  label: '1080p · 30 FPS' },
  '1080p60': { w: 1920, h: 1080, fps: 60, kbps: 8000,  label: '1080p · 60 FPS' },
  '1440p30': { w: 2560, h: 1440, fps: 30, kbps: 10000, label: '1440p · 30 FPS', hidden: true },
  '1440p60': { w: 2560, h: 1440, fps: 60, kbps: 14000, label: '1440p · 60 FPS' },
};
// Para onde descer quando não dá conta: captura lenta (jogo tomando a placa) -> mesmo tamanho a 30 FPS;
// codificador lento -> um tamanho abaixo, mesmo FPS.
const STEP_DOWN = {
  capture: { '1440p60': '1440p30', '1080p60': '1080p30', '720p60': '720p30', '1440p30': '1080p30', '1080p30': '720p30' },
  encoder: { '1440p60': '1080p60', '1080p60': '720p60', '720p60': '720p30', '1440p30': '1080p30', '1080p30': '720p30' },
};

// Codificadores em ordem de preferência. "gpu: true" = recebe os quadros direto da placa de vídeo.
// Cada um tem uma versão completa (ajustada p/ baixa latência) e uma mínima (caso o driver recuse algum ajuste).
const ENCODERS = [
  { id: 'nvenc', label: 'NVIDIA NVENC', gpu: true,
    full: (b, g) => `nvd3d11h264enc bitrate=${b} rc-mode=cbr gop-size=${g} bframes=0 preset=p4 tune=ultra-low-latency`,
    min: (b) => `nvd3d11h264enc bitrate=${b}` },
  { id: 'amf', label: 'AMD AMF', gpu: true,
    full: (b, g) => `amfh264enc bitrate=${b} rate-control=cbr gop-size=${g} usage=ultra-low-latency preset=balanced`,
    min: (b) => `amfh264enc bitrate=${b}` },
  { id: 'qsv', label: 'Intel Quick Sync', gpu: true,
    full: (b, g) => `qsvh264enc bitrate=${b} rate-control=cbr gop-size=${g} b-frames=0 low-latency=true`,
    min: (b) => `qsvh264enc bitrate=${b}` },
  { id: 'mf', label: 'Windows Media Foundation', gpu: false,
    full: (b, g) => `mfh264enc bitrate=${b} rc-mode=cbr gop-size=${g} bframes=0 low-latency=true`,
    min: (b) => `mfh264enc bitrate=${b}` },
  { id: 'openh264', label: 'OpenH264 (processador)', gpu: false,
    full: (b, g) => `openh264enc bitrate=${b * 1000} gop-size=${g}`,
    min: (b) => `openh264enc bitrate=${b * 1000}` },
];

// AV1: mesma placa, mesmo custo, imagem bem melhor com a mesma internet (RTX 40+, Radeon RX 7000+, Intel Arc).
const AV1_ENCODERS = {
  nvenc: { full: (b, g) => `nvd3d11av1enc bitrate=${b} rc-mode=cbr gop-size=${g} preset=p4 tune=ultra-low-latency`,
           min: (b) => `nvd3d11av1enc bitrate=${b}` },
  amf:   { full: (b, g) => `amfav1enc bitrate=${b} rate-control=cbr gop-size=${g} usage=ultra-low-latency`,
           min: (b) => `amfav1enc bitrate=${b}` },
  qsv:   { full: (b, g) => `qsvav1enc bitrate=${b} rate-control=cbr gop-size=${g}`,
           min: (b) => `qsvav1enc bitrate=${b}` },
};
const GST_VER = '1.28.8';

const q = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; // aspas no formato do GStreamer

module.exports = function createEngine({ getCfg, setCfg, send, slug, serverHost, PORTS, ROOM_USER, apiFetch }) {
  const isWin = process.platform === 'win32';
  const resDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'resources');
  const userGst = path.join(app.getPath('userData'), 'gst-1.28.8');
  // o motor vem em resources/gst; numa atualização pequena ele pode vir como resources/gst.zip,
  // e aí é descompactado (uma vez) na pasta de dados do app.
  let gstRoot = fs.existsSync(path.join(resDir, 'gst', 'bin')) ? path.join(resDir, 'gst') : path.join(userGst, 'gst');
  const bin = (n) => path.join(gstRoot, 'bin', n + (isWin ? '.exe' : ''));
  let unpacking = null;
  function ensureGst() {
    if (fs.existsSync(bin('gst-launch-1.0'))) return Promise.resolve(true);
    // pode vir em partes: gst.zip, gst-1.zip, gst-2.zip…
    const zips = fs.readdirSync(resDir).filter((f) => /^gst(-\d+)?\.zip$/i.test(f)).map((f) => path.join(resDir, f));
    if (!zips.length) return Promise.resolve(false);
    if (unpacking) return unpacking;
    send('stream:state', { state: 'iniciando', detail: 'Preparando o motor de vídeo (só na primeira vez)…' });
    fs.mkdirSync(userGst, { recursive: true });
    const untar = (zip) => new Promise((resolve) => {
      // tar.exe vem no Windows 10/11 e abre .zip
      execFile('tar.exe', ['-xf', zip, '-C', userGst], { windowsHide: true, timeout: 180000 }, (err) => {
        if (err) log('falha ao descompactar ' + zip + ': ' + err.message);
        resolve();
      });
    });
    unpacking = (async () => {
      for (const z of zips) await untar(z);
      unpacking = null;
      gstRoot = path.join(userGst, 'gst');
      const ok = fs.existsSync(bin('gst-launch-1.0'));
      send('stream:state', state);
      return ok;
    })();
    return unpacking;
  }
  const logPath = path.join(app.getPath('userData'), 'motor.log');

  let proc = null;
  let wantLive = false;       // o usuário quer estar ao vivo (para reconectar se cair)
  let retries = 0;
  let current = null;         // { sourceName, kind, audio, quality, encoder }
  let state = { state: 'parado' };
  let lastErrors = [];
  let liveCheck = null;
  let av1 = { ok: false };
  // ajuste automático (como o Discord): qualidade que a pessoa escolheu x a que está rodando agora
  const auto = { userQuality: null, upTimer: null, backoffMs: 5 * 60 * 1000, probing: false, probeOkTimer: null };
  function resetAuto() {
    clearTimeout(auto.upTimer); clearTimeout(auto.probeOkTimer);
    Object.assign(auto, { userQuality: null, upTimer: null, backoffMs: 5 * 60 * 1000, probing: false, probeOkTimer: null });
  }

  function setState(s) {
    state = { ...s, source: current?.sourceName, quality: current && QUALITY[current.quality]?.label, encoder: current?.encoderLabel,
      codec: current?.codec === 'av1' ? 'AV1' : 'H.264', audioLabel: current?.audioLabel || null, kbpsScale: current?.kbpsScale ?? 1 };
    send('stream:state', state);
  }

  function env() {
    const e = { ...process.env };
    e.PATH = path.join(gstRoot, 'bin') + path.delimiter + (e.PATH || '');
    e.GST_PLUGIN_SYSTEM_PATH_1_0 = path.join(gstRoot, 'lib', 'gstreamer-1.0');
    e.GST_PLUGIN_PATH_1_0 = path.join(gstRoot, 'lib', 'gstreamer-1.0');
    e.GST_PLUGIN_SCANNER_1_0 = path.join(gstRoot, 'libexec', 'gstreamer-1.0', 'gst-plugin-scanner' + (isWin ? '.exe' : ''));
    e.GST_REGISTRY_1_0 = path.join(app.getPath('userData'), 'gst-registry.bin');
    e.GST_DEBUG = e.GST_DEBUG || '2';
    e.GST_DEBUG_NO_COLOR = '1';
    return e;
  }

  function log(...lines) {
    try { fs.appendFileSync(logPath, lines.map((l) => `[${new Date().toISOString()}] ${l}`).join('\n') + '\n'); } catch {}
  }

  // roda um gst-launch curto e devolve { ok, out }
  function runOnce(args, timeoutMs = 15000) {
    return new Promise((resolve) => {
      let out = '';
      let done = false;
      const p = spawn(bin('gst-launch-1.0'), args, { env: env(), windowsHide: true });
      const finish = (ok) => { if (done) return; done = true; clearTimeout(t); try { p.kill(); } catch {} resolve({ ok, out }); };
      const t = setTimeout(() => finish(false), timeoutMs);
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      p.on('error', (e) => { out += String(e); finish(false); });
      p.on('exit', (code) => finish(code === 0 && !/ERROR:|erroneous pipeline/.test(out)));
    });
  }
  const split = (pipeline) => pipeline.match(/(?:[^\s"]+|"(?:\\.|[^"\\])*")+/g); // separa respeitando aspas

  /* ---------- descobrir o codificador ---------- */
  async function detectEncoder(force = false) {
    await ensureGst();
    const cfg = getCfg();
    if (!force && cfg.encoder && cfg.encoderGst === '1.28.8') return cfg.encoder;
    const tried = [];
    for (const enc of ENCODERS) {
      for (const variant of ['full', 'min']) {
        const encStr = enc[variant](4000, 60);
        const pipe = enc.gpu
          ? `d3d11testsrc num-buffers=30 ! d3d11convert ! video/x-raw(memory:D3D11Memory),format=NV12,width=1280,height=720 ! ${encStr} ! h264parse ! fakesink`
          : `videotestsrc num-buffers=30 ! video/x-raw,format=NV12,width=1280,height=720 ! ${encStr} ! h264parse ! fakesink`;
        const r = await runOnce(split(pipe), 20000);
        tried.push(`${enc.id}/${variant}: ${r.ok ? 'OK' : 'falhou'}`);
        log(`teste codificador ${enc.id}/${variant}: ${r.ok ? 'OK' : 'falhou'}`, r.ok ? '' : r.out.slice(-600));
        if (r.ok) {
          const found = { id: enc.id, variant, label: enc.label, tried };
          setCfg({ encoder: found, encoderGst: '1.28.8' });
          return found;
        }
      }
    }
    return { id: null, tried };
  }

  // a placa comprime em AV1? (testa uma vez e guarda)
  async function detectAv1(encoder) {
    const cfg = getCfg();
    if (cfg.av1 && cfg.av1.enc === encoder.id && cfg.av1.gst === GST_VER) return cfg.av1;
    const a = AV1_ENCODERS[encoder.id];
    let res = { ok: false, enc: encoder.id, gst: GST_VER };
    if (a) {
      for (const variant of ['full', 'min']) {
        const pipe = `d3d11testsrc num-buffers=30 ! d3d11convert ! video/x-raw(memory:D3D11Memory),format=NV12,width=1280,height=720 ! ${a[variant](4000, 60)} ! av1parse ! rtpav1pay ! fakesink`;
        const r = await runOnce(split(pipe), 20000);
        log(`teste AV1 ${encoder.id}/${variant}: ${r.ok ? 'OK' : 'falhou'}`, r.ok ? '' : r.out.slice(-400));
        if (r.ok) { res = { ok: true, variant, enc: encoder.id, gst: GST_VER }; break; }
      }
    }
    setCfg({ av1: res });
    return res;
  }

  /* ---------- fontes (telas e janelas) ---------- */
  async function sources() {
    const list = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true });
    return list
      .filter((s) => !/^Tel(ã|a)o$/.test(s.name)) // não mostrar o próprio Telão
      .map((s) => {
        const [kind, num] = s.id.split(':');
        return {
          id: s.id,
          kind,                       // 'screen' | 'window'
          name: kind === 'screen' ? `Tela ${Number(num) + 1}` : s.name,
          index: kind === 'screen' ? Number(num) : undefined,
          displayId: s.display_id || undefined,
          hwnd: kind === 'window' ? Number(num) : undefined,
          thumb: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : null,
          icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.resize({ width: 32 }).toDataURL() : null,
        };
      })
      .filter((s) => s.kind === 'screen' || s.name);
  }

  /* ---------- PID do programa dono de uma janela (para pegar só o som dele) ---------- */
  function pidOfWindow(hwnd) {
    if (!isWin || !hwnd) return Promise.resolve(null);
    const ps = `Add-Type -Namespace T -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint p);'; $p=0; [void][T.W]::GetWindowThreadProcessId([IntPtr]${Number(hwnd)}, [ref]$p); $p`;
    return new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 8000 }, (err, out) => {
        const pid = Number(String(out || '').trim());
        resolve(!err && pid > 0 ? pid : null);
      });
    });
  }

  /* ---------- som automático: só o jogo, nunca a voz do Discord/WhatsApp ----------
   * Procura, de cima para baixo, uma janela que cobre a tela inteira que está sendo transmitida (o jogo em
   * tela cheia ou sem bordas). Também acha o processo principal do Discord e do WhatsApp para deixá-los de fora.
   */
  const NOT_GAME = /^(explorer|telao|tel(ã|a)o|electron|shellexperiencehost|startmenuexperiencehost|searchhost|textinputhost|applicationframehost|lockapp|systemsettings|discord|whatsapp|whatsapp\.root|msedgewebview2|nvidia overlay|steamwebhelper|gamebar|gamebarftserver|widgets|rtkuwp)$/i;
  function audioTargets(hmonitor) {
    if (!isWin) return Promise.resolve({});
    const ps = `
$ErrorActionPreference='SilentlyContinue'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public class TFS {
  [StructLayout(LayoutKind.Sequential)] public struct R { public int l, t, r, b; }
  [StructLayout(LayoutKind.Sequential)] public struct MI { public int cb; public R m; public R w; public uint f; }
  public delegate bool EP(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EP cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MI i);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  public static string Find(long mon) {
    var res = new StringBuilder();
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h) || IsIconic(h)) return true;
      int cloaked; if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      IntPtr m = MonitorFromWindow(h, 0);
      if (m == IntPtr.Zero || (mon != 0 && m.ToInt64() != mon)) return true;
      MI i = new MI(); i.cb = Marshal.SizeOf(i); GetMonitorInfo(m, ref i);
      R r; GetWindowRect(h, out r);
      if (r.l <= i.m.l && r.t <= i.m.t && r.r >= i.m.r && r.b >= i.m.b) { uint pid; GetWindowThreadProcessId(h, out pid); res.Append(pid).Append(' '); }
      return true;
    }, IntPtr.Zero);
    return res.ToString();
  }
}
'@
$game = $null
foreach ($id in ([TFS]::Find(${Number(hmonitor) || 0}) -split ' ' | Where-Object { $_ })) {
  $p = Get-Process -Id ([int]$id); if (-not $p) { continue }
  if ($p.ProcessName -notmatch '${NOT_GAME.source.replace(/'/g, "''")}') { $game = @{ pid = $p.Id; name = $p.ProcessName }; break }
}
function MainPid($n) {
  $all = @(Get-CimInstance Win32_Process -Filter "Name='$n'"); if (-not $all.Count) { return $null }
  $ids = $all | ForEach-Object { $_.ProcessId }
  $root = $all | Where-Object { $ids -notcontains $_.ParentProcessId } | Select-Object -First 1
  if ($root) { return $root.ProcessId } else { return $all[0].ProcessId }
}
@{ game = $game; discord = (MainPid 'Discord.exe'); whatsapp = (MainPid 'WhatsApp.exe') } | ConvertTo-Json -Compress`;
    return new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15000 }, (err, out) => {
        try { resolve(JSON.parse(String(out).trim().split(/\r?\n/).pop())); } catch { log('som automático: ' + (err ? err.message : out)); resolve({}); }
      });
    });
  }

  /* ---------- HMONITOR de uma tela (o Electron e o motor numeram as telas diferente) ---------- */
  function monitorHandle(displayId) {
    if (!isWin) return Promise.resolve(null);
    const d = screen.getAllDisplays().find((x) => String(x.id) === String(displayId)) || null;
    if (!d) return Promise.resolve(null);
    const c = screen.dipToScreenPoint({ x: Math.round(d.bounds.x + d.bounds.width / 2), y: Math.round(d.bounds.y + d.bounds.height / 2) });
    const ps = `Add-Type -Namespace T -Name M -MemberDefinition '[StructLayout(LayoutKind.Sequential)] public struct P { public int x; public int y; } [DllImport("user32.dll")] public static extern System.IntPtr MonitorFromPoint(P pt, uint f);'; $p = New-Object T.M+P; $p.x=${Math.round(c.x)}; $p.y=${Math.round(c.y)}; [T.M]::MonitorFromPoint($p, 2).ToInt64()`;
    return new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 8000 }, (err, out) => {
        const h = Number(String(out || '').trim());
        log(`tela ${displayId} -> HMONITOR ${h || 'falhou'} ${err ? err.message : ''}`);
        resolve(!err && h > 0 ? h : null);
      });
    });
  }

  /* ---------- medidor de FPS real (o que a captura produz e o que sai do codificador) ----------
   * Se o jogo estiver tomando a placa, a captura entrega menos quadros que o pedido e a transmissão engasga.
   * Igual o Discord, quando isso acontece por vários segundos a gente sugere 30 FPS, que fica liso.
   */
  function startMeter(p) {
    let cap = 0, enc = 0;
    const hist = [];
    let suggested = false;
    let warmup = 5; // ignora os primeiros segundos (o codificador ainda está aquecendo)
    const target = (QUALITY[current.quality] || QUALITY['1080p60']).fps;
    const timer = setInterval(() => {
      if (p !== proc) return clearInterval(timer);
      const sample = { cap, enc };
      cap = 0; enc = 0;
      if (!sample.cap && !sample.enc) return; // ainda sem quadros (conectando) ou -v sem saída
      const info = { capFps: sample.cap, encFps: sample.enc, target };
      if (warmup > 0) { warmup--; send('stream:fps', info); return; }
      hist.push(sample); if (hist.length > 8) hist.shift();
      const avg = (k) => Math.round(hist.reduce((a, x) => a + x[k], 0) / hist.length);
      // sugestão só quando o problema é constante: em pelo menos 7 dos últimos 8 segundos
      if (!suggested && hist.length === 8) {
        const m = target >= 60 ? 8 : 5; // folga: 60 FPS aceita até 52; 30 FPS aceita até 25
        const capLow = hist.filter((x) => x.cap >= target / 4 && x.cap < target - m).length;
        const encLow = hist.filter((x) => x.cap >= target - m / 2 && x.enc < x.cap - m).length;
        if (capLow >= 7) { suggested = true; info.hint = { kind: 'capture', avg: avg('cap') }; }
        else if (encLow >= 7) { suggested = true; info.hint = { kind: 'encoder', avg: avg('enc') }; }
      }
      if (info.hint && getCfg().autoFps !== false) {
        const done = autoStepDown(info.hint);
        if (done) { info.auto = done; delete info.hint; }
      }
      info.autoActive = !!(auto.userQuality && current && current.quality !== auto.userQuality);
      send('stream:fps', info);
    }, 1000);
    return {
      feed(line) {
        if (line.includes('capmeter: last-message')) { cap++; return true; }
        if (line.includes('encmeter: last-message')) { enc++; return true; }
        return /last-message =/.test(line); // outras notificações do -v não interessam
      },
      stop() { clearInterval(timer); send('stream:fps', null); },
    };
  }

  /* ---------- prioridade da captura ----------
   * Com o jogo usando 100% da placa de vídeo, o Windows deixa a captura por último na fila e os quadros
   * atrasam (é o "FPS caindo na transmissão"). O OBS resolve subindo a prioridade na GPU; aqui fazemos igual:
   * processador em "Alta" e GPU em HIGH (D3DKMTSetProcessSchedulingPriorityClass), só para o processo de captura.
   */
  function boostPriority(pid) {
    if (!isWin || !pid) return;
    const ps = `$ErrorActionPreference='SilentlyContinue';
Add-Type -Namespace T -Name G -MemberDefinition '[DllImport("gdi32.dll")] public static extern int D3DKMTSetProcessSchedulingPriorityClass(System.IntPtr h, int p);';
$p = Get-Process -Id ${Number(pid)}; $cpu = 'falhou'; try { $p.PriorityClass = 'High'; $cpu = 'alta' } catch {}
$gpu = [T.G]::D3DKMTSetProcessSchedulingPriorityClass($p.Handle, 4);
"cpu=$cpu gpu=" + ($(if ($gpu -eq 0) {'alta'} else {'codigo ' + $gpu}))`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15000 }, (err, out) => {
      log(`prioridade da captura: ${String(out || '').trim() || (err ? err.message : '?')}`);
    });
  }

  /* ---------- montar o pipeline ---------- */
  function buildPipeline({ source, audio, audioPid, audioExcludePid, quality, encoder, endpoint, token, codec = 'h264', av1Variant = 'full', kbpsScale = 1 }) {
    const Q = QUALITY[quality] || QUALITY['1080p60'];
    const enc = ENCODERS.find((e) => e.id === encoder.id);
    const kbps = Math.round(Q.kbps * kbpsScale);
    const isAv1 = codec === 'av1' && AV1_ENCODERS[encoder.id];
    // quadro-chave a cada 1 s (recupera rápido de engasgos)
    const encStr = isAv1 ? AV1_ENCODERS[encoder.id][av1Variant](kbps, Q.fps) : enc[encoder.variant || 'full'](kbps, Q.fps);
    const pay = isAv1
      ? ['! av1parse', '! rtpav1pay pt=96', '! application/x-rtp,media=video,encoding-name=AV1,payload=96,clock-rate=90000']
      : ['! h264parse config-interval=-1', '! rtph264pay pt=96 config-interval=-1 aggregate-mode=zero-latency',
         '! application/x-rtp,media=video,encoding-name=H264,payload=96,clock-rate=90000'];

    const src = source.kind === 'window'
      ? `d3d11screencapturesrc window-handle=${source.hwnd} capture-api=wgc window-capture-mode=client show-cursor=true show-border=false`
      : source.hmonitor
        ? `d3d11screencapturesrc monitor-handle=${source.hmonitor} show-cursor=true`
        : `d3d11screencapturesrc monitor-index=${source.index || 0} show-cursor=true`;

    const toEncoder = enc.gpu
      ? `d3d11convert ! video/x-raw(memory:D3D11Memory),format=NV12,width=${Q.w},height=${Q.h}`
      : `d3d11convert ! video/x-raw(memory:D3D11Memory),format=NV12,width=${Q.w},height=${Q.h} ! d3d11download ! video/x-raw,format=NV12`;

    const video = [
      src, `! video/x-raw(memory:D3D11Memory),framerate=${Q.fps}/1`,
      '! identity name=capmeter silent=false',
      '! queue max-size-buffers=3 leaky=downstream',
      `! ${toEncoder}`,
      `! ${encStr}`,
      '! identity name=encmeter silent=false',
      ...pay,
      '! queue ! whip.sink_0',
    ].join(' ');

    let audioPart = [
      'audiotestsrc wave=silence is-live=true',
      '! audioconvert ! audioresample ! audio/x-raw,rate=48000,channels=2',
      '! opusenc bitrate=16000 frame-size=20',
      '! rtpopuspay pt=97',
      '! application/x-rtp,media=audio,encoding-name=OPUS,payload=97,clock-rate=48000',
      '! queue ! whip.sink_1',
    ].join(' ');
    if (audio !== 'none') {
      const mode = audioPid
        ? `loopback-mode=include-process-tree loopback-target-pid=${audioPid}`
        : audio === 'pc' ? `loopback-mode=exclude-process-tree loopback-target-pid=${audioExcludePid || process.pid}` : '';
      audioPart = [
        `wasapi2src loopback=true low-latency=true ${mode}`,
        '! queue max-size-time=200000000 leaky=downstream',
        '! audioconvert ! audioresample ! audio/x-raw,rate=48000,channels=2',
        '! opusenc bitrate=128000 frame-size=10',
        '! rtpopuspay pt=97',
        '! application/x-rtp,media=audio,encoding-name=OPUS,payload=97,clock-rate=48000',
        '! queue ! whip.sink_1',
      ].join(' ');
    }

    const sink = `whipsink name=whip whip-endpoint=${q(endpoint)} auth-token=${q(token)} stun-server=${q('stun://stun.l.google.com:19302')}`;
    return [sink, video, audioPart].filter(Boolean).join(' ');
  }

  /* ---------- iniciar / parar ---------- */
  async function start(opts) {
    const cfg = getCfg();
    const host = serverHost();
    if (!host || !cfg.password) return { ok: false, error: 'Configure a sala primeiro.' };
    await stop(true);

    // antes de tudo: a sala responde? (senão o erro certo é de rede, não do motor)
    setState({ state: 'iniciando', detail: 'Procurando a sala…' });
    const reach = await probeRoom();
    if (!reach.ok) { setState({ state: 'erro', detail: reach.error }); return { ok: false, error: reach.error }; }
    if (!(await ensureGst())) { setState({ state: 'erro', detail: 'Motor de vídeo não encontrado na pasta do app.' }); return { ok: false, error: state.detail }; }

    setState({ state: 'iniciando', detail: 'Preparando a placa de vídeo…' });
    const encoder = await detectEncoder(false);
    if (!encoder.id) {
      setState({ state: 'erro', detail: 'Nenhum codificador de vídeo funcionou neste PC. Use "Testar motor" nas configurações e me mande o relatório.' });
      return { ok: false, error: state.detail };
    }

    const list = await sources();
    let source = list.find((s) => s.id === opts.sourceId)
      || list.find((s) => s.kind === opts.kind && s.name === opts.sourceName)
      || list.find((s) => s.kind === 'screen');
    if (!source) { setState({ state: 'erro', detail: 'Não achei nenhuma tela para capturar.' }); return { ok: false, error: state.detail }; }

    // som: 'auto' = janela -> só o app dela; tela -> só o jogo em tela cheia nela, senão o PC todo sem
    // Discord/WhatsApp (a voz de vocês não volta como eco); 'app:<id>' = só aquele app; 'pc' = tudo
    const hmonitor = source.kind === 'screen' ? await monitorHandle(source.displayId) : null;
    let audio = opts.audio || 'auto';
    let audioPid = null, audioExcludePid = null, audioLabel = null;
    if (audio === 'auto' && source.kind === 'window') audio = 'app:' + source.id;
    if (audio === 'auto') {
      const t = await audioTargets(hmonitor);
      if (t.game && t.game.pid) { audio = 'game'; audioPid = t.game.pid; audioLabel = `só o som de ${t.game.name}`; }
      else {
        audio = 'pc';
        audioExcludePid = t.discord || t.whatsapp || null;
        audioLabel = t.discord ? 'som do PC, sem o Discord' : t.whatsapp ? 'som do PC, sem o WhatsApp' : 'som do PC';
      }
      log(`som automático: ${audioLabel}`);
    }
    if (audio.startsWith('app:')) {
      const target = list.find((s) => s.id === audio.slice(4)) || (source.kind === 'window' ? source : null);
      audioPid = target ? await pidOfWindow(target.hwnd) : null;
      audioLabel = target ? `só o som de ${target.name}` : null;
      if (!audioPid) { audio = 'pc'; audioLabel = 'som do PC'; }
    }

    current = {
      sourceId: source.id, sourceName: source.name, kind: source.kind, hwnd: source.hwnd, index: source.index, hmonitor,
      audio, audioPid, audioExcludePid, audioLabel, quality: opts.quality || '1080p60', encoder, encoderLabel: encoder.label,
      codec: 'h264', kbpsScale: 1,
    };
    // AV1 só entra quando todo mundo que está assistindo consegue abrir (o app de quem assiste avisa)
    av1 = getCfg().codecPref === 'h264' ? { ok: false } : await detectAv1(encoder);
    const vNow = (await fetchViewers().catch(() => [])).filter((v) => !v.self);
    if (av1.ok && vNow.length && vNow.every((v) => v.av1)) current.codec = 'av1';
    setCfg({ lastStream: { kind: source.kind, sourceName: source.name, audio: opts.audio || 'auto', quality: current.quality } });
    resetAuto();
    auto.userQuality = current.quality;
    wantLive = true;
    retries = 0;
    launch();
    return { ok: true };
  }

  async function launch(opts = {}) {
    const cfg = getCfg();
    const name = slug(cfg.name);
    await ensurePath(name, current.codec);
    const pipeline = buildPipeline({
      source: current, audio: current.audio, audioPid: current.audioPid, audioExcludePid: current.audioExcludePid,
      quality: current.quality, encoder: current.encoder,
      codec: current.codec, av1Variant: av1.variant || 'full', kbpsScale: current.kbpsScale,
      endpoint: `http://${serverHost()}:${PORTS.webrtc}/${name}/whip`,
      token: `${ROOM_USER}:${cfg.password}`,
    });
    log('---- iniciando ----', 'pipeline: ' + pipeline.replace(/auth-token="[^"]*"/, 'auth-token="***"'));
    lastErrors = [];
    if (!opts.seamless) setState({ state: 'iniciando', detail: 'Conectando à sala…' });

    const p = spawn(bin('gst-launch-1.0'), ['-e', '-v', ...split(pipeline)], { env: env(), windowsHide: true });
    let reachedLive = false; // esta tentativa chegou a ficar ao vivo?
    proc = p;
    boostPriority(p.pid);
    const meter = startMeter(p);
    let partial = '';
    const onData = (d) => {
      const lines = (partial + String(d)).split(/\r?\n/);
      partial = lines.pop(); // última linha pode vir cortada
      for (const line of lines) {
        if (!line) continue;
        if (meter.feed(line)) continue; // linha de contagem de quadros
        if (/ERROR|erroneous|WARN/.test(line)) { lastErrors.push(line); if (lastErrors.length > 40) lastErrors.shift(); log(line); }
      }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', (e) => { lastErrors.push(String(e)); log(String(e)); });
    p.on('exit', (code) => {
      if (p !== proc) return;
      proc = null;
      meter.stop();
      clearInterval(liveCheck);
      log(`motor saiu (código ${code})`);
      if (!wantLive) { setState({ state: 'parado' }); return; }
      const err = lastErrors.filter((l) => /ERROR|erroneous/.test(l)).slice(-3).join('\n');

      // Windows sem suporte a "som só de um app" (precisa Win 10 21H1+/Win 11): cai para o som do PC todo
      if (/wasapi2|loopback/i.test(err) && current.audioPid) {
        current.audioPid = null; current.audio = 'pc'; current.audioLabel = 'som do PC';
        send('stream:notice', 'Seu Windows não deixa pegar o som de um app só — usando o som do PC todo.');
        return launch();
      }
      if (/wasapi2|loopback/i.test(err) && current.audio === 'pc') {
        current.audio = 'pc-simple';
        return launch();
      }
      // AV1 falhou neste PC: desliga AV1 de vez e volta para H.264
      if (current.codec === 'av1' && !reachedLive && /av1|property|enum|no element|could not link|not-negotiated|encoder/i.test(err)) {
        if (av1.variant === 'full') { av1 = { ...av1, variant: 'min' }; return launch(); }
        av1 = { ok: false }; setCfg({ av1: { ok: false, enc: current.encoder.id, gst: GST_VER } });
        current.codec = 'h264';
        log('AV1 falhou, voltando para H.264');
        return launch();
      }
      // driver recusou algum ajuste fino do codificador: tenta a versão mínima
      if (/property|enum|no element|could not link|not-negotiated|encoder/i.test(err) && current.encoder.variant === 'full') {
        current.encoder = { ...current.encoder, variant: 'min' };
        return launch();
      }
      if (retries < 3) {
        retries++;
        setState({ state: 'iniciando', detail: `Caiu — reconectando (${retries}/3)…` });
        setTimeout(() => { if (wantLive && !proc) launch(); }, 2000 * retries);
        return;
      }
      wantLive = false;
      probeRoom().then((r) => setState({ state: 'erro', detail: r.ok ? friendlyError(err) : r.error }));
    });

    // confere no servidor quando a transmissão realmente apareceu
    clearInterval(liveCheck);
    let n = 0;
    liveCheck = setInterval(async () => {
      if (p !== proc) return clearInterval(liveCheck);
      n++;
      const r = await apiFetch(`/v3/paths/get/${encodeURIComponent(name)}`).catch(() => null);
      if (r && (r.online ?? r.ready)) {
        clearInterval(liveCheck);
        reachedLive = true;
        retries = 0;
        setState({ state: 'ao-vivo' });
        startViewerWatch();
      } else if (n === 25) {
        lastErrors.push('ERROR: o servidor não recebeu o vídeo em 25 s');
        setState({ state: 'iniciando', detail: 'Demorando para conectar… confira o endereço da sala.' });
      }
    }, 1000);
  }

  /* ---------- troca de qualidade sem derrubar quem assiste ----------
   * Sobe uma transmissão nova com a qualidade nova ENQUANTO a antiga ainda está no ar. O servidor troca uma
   * pela outra ("override") e, como o caminho é "sempre disponível", quem assiste não desconecta: só a
   * qualidade muda. Testado: zero quadros perdidos no leitor durante a troca.
   */
  function switchQuality(quality) {
    if (!proc || !wantLive || current.quality === quality) return false;
    const old = proc;
    current.quality = quality;
    log(`troca de qualidade -> ${quality}`);
    launch({ seamless: true }); // "proc" passa a ser o novo; a saída do antigo é ignorada
    setTimeout(() => { try { old.kill(); } catch {} }, 8000); // o servidor já derrubou; garante que fecha
    setTimeout(() => { if (wantLive) setState({ state: state.state === 'iniciando' ? 'iniciando' : 'ao-vivo' }); }, 1500);
    return true;
  }

  function autoStepDown(hint) {
    const next = STEP_DOWN[hint.kind]?.[current.quality];
    if (!next || !switchQuality(next)) return null;
    // se caiu durante uma tentativa de voltar, espera o dobro antes de tentar de novo (máx. 40 min)
    if (auto.probing) auto.backoffMs = Math.min(auto.backoffMs * 2, 40 * 60 * 1000);
    auto.probing = false;
    clearTimeout(auto.probeOkTimer);
    scheduleStepUp();
    const from = QUALITY[auto.userQuality]?.label, to = QUALITY[next].label;
    send('stream:notice', hint.kind === 'capture'
      ? `O jogo está pesando: baixei para ${to} para ficar liso. Volto para ${from} sozinho quando der.`
      : `O codificador não está dando conta: baixei para ${to}. Volto para ${from} sozinho quando der.`);
    return { from: auto.userQuality, to: next, kind: hint.kind };
  }

  function scheduleStepUp() {
    clearTimeout(auto.upTimer);
    auto.upTimer = setTimeout(() => {
      if (!wantLive || !auto.userQuality || current.quality === auto.userQuality) return;
      auto.probing = true;
      log(`tentando voltar para ${auto.userQuality}`);
      if (!switchQuality(auto.userQuality)) return;
      // se ficar 40 s sem cair de novo, deu certo: volta a esperar só 5 min na próxima vez
      clearTimeout(auto.probeOkTimer);
      auto.probeOkTimer = setTimeout(() => {
        if (auto.probing && current.quality === auto.userQuality) {
          auto.probing = false; auto.backoffMs = 5 * 60 * 1000;
          send('stream:notice', `Voltei para ${QUALITY[auto.userQuality].label}.`);
        }
      }, 40000);
    }, auto.backoffMs);
  }

  // cria o caminho desta pessoa como "sempre disponível" (quem assiste continua conectado nas trocas de qualidade)
  const pathTracks = (codec) => [{ codec: codec === 'av1' ? 'AV1' : 'H264' }, { codec: 'Opus' }];
  async function apiJson(apiPath, method = 'GET', body) {
    const r = await fetch(`http://${serverHost()}:${PORTS.api}${apiPath}`, {
      method,
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${ROOM_USER}:${getCfg().password}`).toString('base64'),
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    return { status: r.status, ok: r.ok, json: j };
  }
  async function ensurePath(name, codec = 'h264') {
    const want = pathTracks(codec);
    try {
      const add = await apiJson(`/v3/config/paths/add/${encodeURIComponent(name)}`, 'POST', { alwaysAvailable: true, alwaysAvailableTracks: want });
      if (add.ok) return;
      // já existe: só mexe se o formato mudou (mexer derruba quem assiste por 1-2 s, então evita)
      const cur = await apiJson(`/v3/config/paths/get/${encodeURIComponent(name)}`);
      const have = (cur.json?.alwaysAvailableTracks || []).map((t) => t.codec).join(',');
      if (have !== want.map((t) => t.codec).join(',')) {
        const r = await apiJson(`/v3/config/paths/patch/${encodeURIComponent(name)}`, 'PATCH', { alwaysAvailable: true, alwaysAvailableTracks: want });
        log(`caminho: formato ${have || '?'} -> ${want[0].codec} (${r.status})`);
      }
    } catch (e) { log('caminho sempre disponível: ' + e.message); }
  }

  /* ---------- quem está assistindo ----------
   * O servidor lista as conexões de quem assiste; o app de quem assiste se identifica no endereço
   * (?tv=1&n=Nome&av1=1) e manda a cada 3 s como está chegando (perda, travadas) para a sala.
   */
  async function fetchViewers() {
    const name = slug(getCfg().name);
    const [sess, fb] = await Promise.all([
      apiJson('/v3/webrtcsessions/list?itemsPerPage=200'),
      apiJson(`/telao/fb?path=${encodeURIComponent(name)}`).catch(() => ({ json: null })),
    ]);
    const reports = (fb.json && fb.json.items) || [];
    return ((sess.json && sess.json.items) || [])
      .filter((x) => x.state === 'read' && x.path === name)
      .map((x) => {
        const qs = new URLSearchParams(x.query || '');
        const known = qs.get('tv') === '1';
        const who = qs.get('n') || 'Alguém';
        const rep = reports.find((r) => r.viewer === who) || null;
        return {
          id: x.id, name: who, known,
          // app antigo (sem ?tv=1) não diz se abre AV1: conta como "não abre"
          av1: known && (rep && typeof rep.av1 === 'boolean' ? rep.av1 : qs.get('av1') === '1'),
          verdict: rep ? rep.verdict : null, loss: rep ? rep.loss : null, fps: rep ? rep.fps : null,
          self: who === getCfg().name,
        };
      });
  }

  const watch = { timer: null, wantAv1: 0, bad: 0, good: 0, lastChange: 0, lastKey: '' };
  function stopViewerWatch() { clearInterval(watch.timer); watch.timer = null; send('stream:viewers', []); }
  function startViewerWatch() {
    if (watch.timer) return;
    Object.assign(watch, { wantAv1: 0, bad: 0, good: 0, lastChange: Date.now(), lastKey: '' });
    watch.timer = setInterval(async () => {
      if (!wantLive || !proc || !current) return;
      let viewers;
      try { viewers = await fetchViewers(); } catch { return; }
      send('stream:viewers', viewers.map((v) => ({ name: v.name, verdict: v.verdict, loss: v.loss, fps: v.fps, known: v.known, self: v.self })));
      const others = viewers.filter((v) => !v.self);
      const now = Date.now();
      const settled = now - watch.lastChange > 15000; // espera a última troca assentar

      // 1) formato: AV1 quando todos abrem, H.264 assim que entra alguém que não abre
      if (av1.ok && getCfg().codecPref !== 'h264') {
        const allAv1 = others.length > 0 && others.every((v) => v.av1);
        if (current.codec === 'h264' && allAv1) {
          if (++watch.wantAv1 >= 4 && settled) { watch.wantAv1 = 0; return switchCodec('av1'); }
        } else watch.wantAv1 = 0;
        if (current.codec === 'av1' && others.some((v) => !v.av1)) return switchCodec('h264');
      }

      // 2) internet de quem assiste: alguém perdendo pacotes -> baixa a taxa; tudo liso por 2 min -> sobe
      if (getCfg().autoFps === false) return;
      const bad = others.some((v) => v.verdict === 'rede');
      if (bad) { watch.bad++; watch.good = 0; } else if (others.some((v) => v.verdict === 'ok')) { watch.good++; watch.bad = 0; }
      if (watch.bad >= 3 && settled && current.kbpsScale > 0.5) {
        watch.bad = 0;
        const next = Math.max(0.5, Math.round(current.kbpsScale * 0.75 * 100) / 100);
        if (switchBitrate(next)) send('stream:notice', `A internet de quem assiste está perdendo pacotes: baixei a taxa para ${Math.round(next * 100)}% para não travar.`);
      } else if (watch.good >= 40 && settled && current.kbpsScale < 1) { // 40 × 3 s = 2 min
        watch.good = 0;
        const next = Math.min(1, Math.round((current.kbpsScale / 0.75) * 100) / 100);
        if (switchBitrate(next) && next === 1) send('stream:notice', 'A internet de quem assiste estabilizou: taxa de volta ao normal.');
      }
    }, 3000);
  }

  // troca de taxa: igual à troca de qualidade (sem derrubar ninguém)
  function switchBitrate(scale) {
    if (!proc || !wantLive) return false;
    const old = proc;
    current.kbpsScale = scale;
    watch.lastChange = Date.now();
    log(`taxa -> ${Math.round(scale * 100)}%`);
    launch({ seamless: true });
    setTimeout(() => { try { old.kill(); } catch {} }, 8000);
    return true;
  }

  // troca de formato (H.264 <-> AV1): quem assiste reconecta sozinho em 1-2 s
  async function switchCodec(codec) {
    if (!proc || !wantLive || current.codec === codec) return;
    const old = proc;
    current.codec = codec;
    watch.lastChange = Date.now();
    log(`formato -> ${codec}`);
    proc = null; // a saída do antigo não conta como queda
    try { old.kill(); } catch {}
    await launch({ seamless: true });
    send('stream:notice', codec === 'av1'
      ? 'Todo mundo que está assistindo abre AV1: mudei para AV1 (imagem mais nítida com a mesma internet).'
      : 'Entrou alguém que não abre AV1: voltei para H.264 para ficar liso para todos.');
    setState({ state: state.state, codec });
  }

  // pede para o servidor derrubar a sessão na hora (senão ela some só depois de alguns segundos)
  async function kickOwnSession() {
    try {
      const name = slug(getCfg().name);
      const list = await apiFetch('/v3/webrtc/sessions/list?itemsPerPage=200');
      for (const s of list?.items || []) {
        if (s.path === name && /publish/.test(s.state)) await apiFetch(`/v3/webrtc/sessions/kick/${s.id}`, 'POST');
      }
    } catch {}
  }

  async function stop(silent = false) {
    wantLive = false;
    resetAuto();
    stopViewerWatch();
    clearInterval(liveCheck);
    const p = proc;
    proc = null;
    if (p) {
      try { p.kill(); } catch {}
      await kickOwnSession();
    }
    if (!silent) setState({ state: 'parado' });
    return { ok: true };
  }

  // testa se o servidor da sala responde, separando "sem rede" de "senha errada"
  async function probeRoom() {
    const cfg = getCfg();
    const host = serverHost();
    try {
      const r = await fetch(`http://${host}:${PORTS.api}/v3/paths/list?itemsPerPage=1`, {
        headers: { Authorization: 'Basic ' + Buffer.from(`${ROOM_USER}:${cfg.password}`).toString('base64') },
        signal: AbortSignal.timeout(5000),
      });
      if (r.status === 401) return { ok: false, error: 'Senha da sala incorreta. Peça um convite novo para o host.' };
      return { ok: true };
    } catch {
      return {
        ok: false,
        error: cfg.hosting
          ? 'A sala deste PC não está respondendo. Feche e abra o Telão de novo.'
          : `Não consigo chegar na sala (${host}). O host está com o Telão aberto? Se vocês usam Hamachi/Radmin, os dois precisam estar conectados na mesma rede; se for pela internet, as portas do host precisam estar abertas.`,
      };
    }
  }

  function friendlyError(err) {
    if (/Could not connect|connection refused|error sending request|tcp connect|dns|timed? ?out|unreachable/i.test(err)) return 'Não consigo chegar na sala. O host está com o Telão aberto e vocês estão na mesma rede (VPN) ou com as portas abertas?';
    if (/401|Unauthorized/i.test(err)) return 'Senha da sala incorreta.';
    if (/window|HWND|capture/i.test(err)) return 'Não deu para capturar essa janela. Se for um jogo em tela cheia exclusiva, mude para "janela sem bordas" ou compartilhe a tela inteira.';
    return 'O motor de vídeo parou. Abra Configurações → "Testar motor" e me mande o relatório.' + (err ? `\n\n${err.slice(0, 300)}` : '');
  }

  /* ---------- diagnóstico ---------- */
  async function diagnose() {
    const okGst = await ensureGst();
    const lines = [`Telão ${app.getVersion()} — diagnóstico do motor`, `Windows: ${require('os').release()}`, `Motor em: ${gstRoot} (${okGst ? 'ok' : 'NÃO ENCONTRADO'})`, ''];
    const step = async (title, pipe, t) => {
      const r = await runOnce(split(pipe), t);
      lines.push(`${r.ok ? '✔' : '✘'} ${title}`);
      if (!r.ok) lines.push('   ' + r.out.split(/\r?\n/).filter((l) => /ERROR|WARN|erroneous|no element|property/.test(l)).slice(-4).join('\n   '));
      return r.ok;
    };
    await step('Motor carrega', 'fakesrc num-buffers=1 ! fakesink', 30000);
    await step('Captura da tela (placa de vídeo)', 'd3d11screencapturesrc monitor-index=0 num-buffers=30 ! fakesink', 15000);
    await step('Som do PC (loopback)', 'wasapi2src loopback=true num-buffers=50 ! fakesink', 15000);
    await step('Som de um app só (Win 10 21H1+/11)', `wasapi2src loopback=true loopback-mode=exclude-process-tree loopback-target-pid=${process.pid} num-buffers=50 ! fakesink`, 15000);
    await step('Opus (áudio)', 'audiotestsrc num-buffers=50 ! audioconvert ! audioresample ! opusenc ! fakesink', 15000);
    const hasWhip = await new Promise((resolve) => {
      execFile(bin('gst-inspect-1.0'), ['--exists', 'whipsink'], { env: env(), windowsHide: true, timeout: 20000 }, (err) => resolve(!err));
    });
    lines.push(`${hasWhip ? '✔' : '✘'} Envio WebRTC (whipsink)`);
    const enc = await detectEncoder(true);
    lines.push('', 'Codificadores testados:', ...enc.tried.map((t) => '   ' + t), '', enc.id ? `→ Vai usar: ${enc.label}` : '→ Nenhum codificador funcionou');
    const report = lines.join('\n');
    log('==== diagnóstico ====', report);
    return report;
  }

  return {
    QUALITY, sources, start, stop, diagnose, detectEncoder,
    state: () => state, isLive: () => wantLive || state.state === 'ao-vivo',
    logPath, _internals: { split, buildPipeline },
  };
};
