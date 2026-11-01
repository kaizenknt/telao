// Telão — integração com o Windows: Firewall, redes virtuais (Hamachi/Tailscale/…) e atualização automática.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { VERSION, REPO } = require('./version');

const isWin = process.platform === 'win32';
const run = (file, args, opts = {}) => new Promise((resolve) => {
  execFile(file, args, { windowsHide: true, timeout: 20000, ...opts }, (err, stdout, stderr) => resolve({ err, out: String(stdout || '') + String(stderr || '') }));
});

/* ================= Firewall ================= */
const RULE_PREFIX = 'Telao';

function firewallTargets(resDir) {
  const t = [
    { name: `${RULE_PREFIX} - servidor`, program: path.join(resDir, 'bin', 'mediamtx.exe') },
    { name: `${RULE_PREFIX} - motor`, program: path.join(resDir, 'gst', 'bin', 'gst-launch-1.0.exe') },
    { name: `${RULE_PREFIX} - app`, program: process.execPath },
  ];
  return t.filter((x) => fs.existsSync(x.program));
}

// Confere se cada programa já tem regra de entrada liberada (em todos os perfis, incluindo "Pública", que é onde o Hamachi cai).
async function firewallStatus(resDir) {
  if (!isWin) return { ok: true, missing: [] };
  const r = await run('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=all', 'dir=in', 'verbose']);
  const text = r.out.toLowerCase();
  const missing = [];
  for (const t of firewallTargets(resDir)) {
    // procura um bloco de regra que tenha este programa, esteja ativo, permita e valha para o perfil público
    const blocks = text.split(/\r?\n\r?\n/).filter((b) => b.includes(t.program.toLowerCase()));
    const good = blocks.some((b) => /enabled:\s*yes|habilitad[ao]:\s*sim/.test(b) && /action:\s*allow|a[cç][aã]o:\s*permitir/.test(b) && /(profiles|perfis):\s*[^\n]*(public|p[uú]blic|any|qualquer)/.test(b));
    if (!good) missing.push(t.name);
  }
  // portas do servidor (só importam para quem é host)
  const portsOk = text.includes(`${RULE_PREFIX.toLowerCase()} - portas`);
  return { ok: missing.length === 0 && portsOk, missing: portsOk ? missing : [...missing, `${RULE_PREFIX} - portas`] };
}

// Cria todas as regras de uma vez. O Windows mostra UM aviso ("Deseja permitir…?") e a pessoa clica em Sim.
async function firewallFix(resDir) {
  if (!isWin) return { ok: true };
  const lines = ['@echo off', 'chcp 65001 >nul'];
  for (const t of firewallTargets(resDir)) {
    lines.push(`netsh advfirewall firewall delete rule name="${t.name}" >nul 2>&1`);
    lines.push(`netsh advfirewall firewall add rule name="${t.name}" dir=in action=allow program="${t.program}" enable=yes profile=any >nul`);
  }
  lines.push(`netsh advfirewall firewall delete rule name="${RULE_PREFIX} - portas" >nul 2>&1`);
  lines.push(`netsh advfirewall firewall add rule name="${RULE_PREFIX} - portas" dir=in action=allow protocol=TCP localport=8889,9997,8189 enable=yes profile=any >nul`);
  lines.push(`netsh advfirewall firewall add rule name="${RULE_PREFIX} - portas" dir=in action=allow protocol=UDP localport=8189 enable=yes profile=any >nul`);
  const script = path.join(app.getPath('userData'), 'liberar-firewall.cmd');
  fs.writeFileSync(script, lines.join('\r\n') + '\r\n');
  const ps = `try { Start-Process -FilePath '${script.replace(/'/g, "''")}' -Verb RunAs -WindowStyle Hidden -Wait; 'ok' } catch { 'cancelado' }`;
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 120000 });
  if (/cancelado/.test(r.out)) return { ok: false, error: 'Você clicou em "Não" no aviso do Windows. Tente de novo e clique em "Sim".' };
  const st = await firewallStatus(resDir);
  return st.ok ? { ok: true } : { ok: false, error: 'O Windows não aplicou todas as regras: ' + st.missing.join(', ') };
}

/* ================= Redes virtuais ================= */
function inRange(ip, a, b) { // a/b como [x, y] para o 1º e 2º octetos
  const [o1, o2] = ip.split('.').map(Number);
  return o1 === a[0] && o2 >= a[1] && o2 <= b[1];
}
function vpnAddresses() {
  const out = [];
  for (const [ifname, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      const ip = a.address;
      const n = ifname.toLowerCase();
      let kind = null;
      if (/hamachi/.test(n) || ip.startsWith('25.')) kind = 'Hamachi';
      else if (/radmin/.test(n) || ip.startsWith('26.')) kind = 'Radmin VPN';
      else if (/tailscale/.test(n) || inRange(ip, [100, 64], [100, 127])) kind = 'Tailscale';
      else if (/zerotier/.test(n)) kind = 'ZeroTier';
      else if (/wireguard|wg\d|netbird/.test(n)) kind = 'VPN';
      if (kind) out.push({ kind, ip, ifname });
    }
  }
  return out;
}

/* ================= Atualização automática ================= */
const cmpVer = (a, b) => {
  const pa = String(a).replace(/^v/, '').split('.').map(Number), pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
};

function createUpdater({ onState }) {
  const dir = () => path.join(app.getPath('userData'), 'update'); // calculado na hora (o caminho é definido depois)
  let state = { state: 'idle', current: VERSION };
  const set = (s) => { state = { ...state, ...s }; onState?.(state); };

  async function check({ apply = true } = {}) {
    try {
      set({ state: 'checking' });
      const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { 'User-Agent': 'Telao', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) return set({ state: 'idle', error: `GitHub respondeu ${r.status}` });
      const rel = await r.json();
      const latest = String(rel.tag_name || '').replace(/^v/, '');
      if (!latest || cmpVer(latest, VERSION) <= 0) return set({ state: 'up-to-date', latest });
      const assets = rel.assets || [];
      const code = assets.find((a) => /^telao-update-.*\.zip$/i.test(a.name));
      const full = assets.find((a) => /windows\.zip$/i.test(a.name));
      // atualização que muda o motor/servidor precisa do pacote completo (marcado no texto da versão)
      const needsFull = /\[completa\]/i.test(rel.body || '') || !code;
      if (needsFull) return set({ state: 'needs-full', latest, url: rel.html_url, fullUrl: full?.browser_download_url, notes: rel.body });
      if (!apply) return set({ state: 'available', latest, notes: rel.body });

      set({ state: 'downloading', latest });
      const zipRes = await fetch(code.browser_download_url, { signal: AbortSignal.timeout(120000) });
      if (!zipRes.ok) throw new Error('download ' + zipRes.status);
      const tmp = path.join(app.getPath('userData'), `update-${latest}.zip`);
      fs.writeFileSync(tmp, Buffer.from(await zipRes.arrayBuffer()));
      const staging = path.join(app.getPath('userData'), `update-${latest}`);
      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(staging, { recursive: true });
      const x = await run('tar.exe', ['-xf', tmp, '-C', staging], { timeout: 60000 });
      if (!fs.existsSync(path.join(staging, 'src', 'main.js'))) throw new Error('pacote inválido ' + x.out.slice(0, 200));
      fs.rmSync(dir(), { recursive: true, force: true });
      fs.renameSync(staging, dir());
      fs.rmSync(tmp, { force: true });
      set({ state: 'ready', latest, notes: rel.body });
    } catch (e) {
      set({ state: 'idle', error: String(e.message || e) });
    }
    return state;
  }

  return { check, state: () => state, relaunch: () => { app.relaunch(); app.exit(0); } };
}

module.exports = { firewallStatus, firewallFix, vpnAddresses, createUpdater, VERSION };
