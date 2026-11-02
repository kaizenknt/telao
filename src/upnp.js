// Telão — abre as portas da sala no roteador sozinho, via UPnP (IGD).
// Sem dependências: descoberta SSDP + chamadas SOAP AddPortMapping / GetExternalIPAddress / DeletePortMapping.
const dgram = require('dgram');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
];

/* ---------- descobrir o roteador ----------
 * Pergunta por TODAS as placas de rede de casa (não só a "padrão": com Hamachi/Radmin instalados, o Windows às
 * vezes manda a pergunta pela placa da VPN e o roteador nunca ouve). Além do grito geral (multicast), pergunta
 * direto para o provável roteador (x.x.x.1 e o 192.168.15.1 da Vivo), que alguns só respondem assim.
 */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(require('os').networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) out.push(a.address);
    }
  }
  return out;
}

function discover(timeoutMs = 4500) {
  if (process.env.TELAO_UPNP_LOCATION) return Promise.resolve([process.env.TELAO_UPNP_LOCATION]); // testes
  return new Promise((resolve) => {
    const found = new Set();
    const socks = [];
    const addrs = lanAddresses();
    const binds = addrs.length ? addrs : [undefined];
    let finished = false;
    const done = () => {
      if (finished) return; finished = true;
      for (const s of socks) { try { s.close(); } catch {} }
      resolve([...found]);
    };
    const msg = (st) => `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDR}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`;
    for (const addr of binds) {
      let sock;
      try { sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }); } catch { continue; }
      socks.push(sock);
      sock.on('error', () => { try { sock.close(); } catch {} });
      sock.on('message', (m) => {
        const x = String(m).match(/^location:\s*(\S+)/im);
        if (x) { found.add(x[1].trim()); if (found.size && !finished) setTimeout(done, 600); }
      });
      sock.bind(0, addr, () => {
        try { if (addr) sock.setMulticastInterface(addr); } catch {}
        const targets = [SSDP_ADDR];
        if (addr) targets.push(addr.replace(/\.\d+$/, '.1'));
        if (addr && addr.startsWith('192.168.15.')) targets.push('192.168.15.1');
        const send = (sts) => { for (const t of [...new Set(targets)]) for (const st of sts) sock.send(msg(st), SSDP_PORT, t, () => {}); };
        send(SEARCH_TARGETS);
        // repete: roteadores às vezes perdem o primeiro pacote
        setTimeout(() => { if (!finished) send(SEARCH_TARGETS.slice(0, 2)); }, 900);
        setTimeout(() => { if (!finished) send(SEARCH_TARGETS.slice(0, 2)); }, 2200);
      });
    }
    setTimeout(done, timeoutMs);
  });
}

/* ---------- ler a descrição e achar o serviço WAN ---------- */
async function findService(location) {
  const r = await fetch(location, { signal: AbortSignal.timeout(5000) });
  const xml = await r.text();
  const base = (xml.match(/<URLBase>\s*([^<]+?)\s*<\/URLBase>/i) || [])[1] || location;
  const services = xml.split(/<service>/i).slice(1).map((s) => ({
    type: (s.match(/<serviceType>\s*([^<]+?)\s*<\/serviceType>/i) || [])[1],
    control: (s.match(/<controlURL>\s*([^<]+?)\s*<\/controlURL>/i) || [])[1],
  })).filter((s) => s.type && s.control);
  // prefere WANIPConnection, depois WANPPPConnection (conexões PPPoE)
  const svc = services.find((s) => /WANIPConnection:\d/.test(s.type)) || services.find((s) => /WANPPPConnection:\d/.test(s.type));
  if (!svc) return null;
  return { type: svc.type, url: new URL(svc.control, base).toString(), host: new URL(location).hostname };
}

/* ---------- SOAP ---------- */
async function soap(svc, action, args = {}) {
  const body = `<?xml version="1.0"?>\r\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${svc.type}">` +
    Object.entries(args).map(([k, v]) => `<${k}>${String(v).replace(/[<&>]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[c]))}</${k}>`).join('') +
    `</u:${action}></s:Body></s:Envelope>`;
  const r = await fetch(svc.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${svc.type}#${action}"` },
    body,
    signal: AbortSignal.timeout(6000),
  });
  const text = await r.text();
  if (!r.ok) {
    const code = (text.match(/<errorCode>\s*(\d+)\s*<\/errorCode>/i) || [])[1];
    const desc = (text.match(/<errorDescription>\s*([^<]*)<\/errorDescription>/i) || [])[1];
    const e = new Error(`${action} falhou (${code || r.status}${desc ? ' ' + desc : ''})`);
    e.code = Number(code) || r.status;
    throw e;
  }
  return text;
}

// IP local do PC na rede do roteador (o "IP interno" das regras)
function localIpToward(host) {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.on('error', () => { try { s.close(); } catch {} resolve(null); });
    s.connect(1900, host, () => {
      let ip = null;
      try { ip = s.address().address; } catch {}
      try { s.close(); } catch {}
      resolve(ip);
    });
  });
}

const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.|0\.)/.test(ip || '');
const isCgnat = (ip) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip || '');

/**
 * Abre as portas pedidas. Retorna { ok, externalIp, localIp, cgnat, opened[], error }.
 * ports: [{ port, protocol: 'TCP'|'UDP' }]
 */
function createUpnp({ ports, description = 'Telao', log = () => {} }) {
  let svc = null;
  let localIp = null;
  let renewTimer = null;
  let state = { status: 'idle' };

  let conflicts = [];
  async function addAll(lease) {
    const opened = [];
    conflicts = [];
    for (const p of ports) {
      const args = {
        NewRemoteHost: '', NewExternalPort: p.port, NewProtocol: p.protocol,
        NewInternalPort: p.port, NewInternalClient: localIp, NewEnabled: 1,
        NewPortMappingDescription: `${description} ${p.port}/${p.protocol}`, NewLeaseDuration: lease,
      };
      try {
        await soap(svc, 'AddPortMapping', args);
        opened.push(`${p.port}/${p.protocol}`);
      } catch (e) {
        // 718 = a porta já tem regra. Só substitui se a regra for do próprio Telão (ou deste PC);
        // regra de outro aparelho da casa nunca é apagada.
        if (e.code === 718) {
          let owner = null;
          try {
            const x = await soap(svc, 'GetSpecificPortMappingEntry', { NewRemoteHost: '', NewExternalPort: p.port, NewProtocol: p.protocol });
            owner = {
              client: (x.match(/<NewInternalClient>\s*([^<]*)<\/NewInternalClient>/i) || [])[1],
              desc: (x.match(/<NewPortMappingDescription>\s*([^<]*)<\/NewPortMappingDescription>/i) || [])[1] || '',
            };
          } catch {}
          const ours = owner && (owner.client === localIp || owner.desc.startsWith(description));
          if (!ours) { conflicts.push(`${p.port}/${p.protocol}${owner?.client ? ' (usada por ' + owner.client + ')' : ''}`); continue; }
          try { await soap(svc, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: p.port, NewProtocol: p.protocol }); } catch {}
          await soap(svc, 'AddPortMapping', args);
          opened.push(`${p.port}/${p.protocol}`);
        } else throw e;
      }
    }
    return opened;
  }

  async function open() {
    state = { status: 'working' };
    try {
      const locations = await discover();
      log(`UPnP: ${locations.length} roteador(es) encontrados`);
      for (const loc of locations) {
        try { svc = await findService(loc); } catch (e) { log('UPnP: descrição falhou ' + e.message); svc = null; }
        if (svc) break;
      }
      if (!svc) return (state = { status: 'unavailable', error: 'O roteador não respondeu ao UPnP (está desligado nele, ou não é suportado).' });
      localIp = await localIpToward(svc.host);
      if (!localIp) return (state = { status: 'error', error: 'Não descobri o IP deste PC na rede.' });

      let externalIp = null;
      try {
        const x = await soap(svc, 'GetExternalIPAddress');
        externalIp = (x.match(/<NewExternalIPAddress>\s*([^<]*)<\/NewExternalIPAddress>/i) || [])[1] || null;
      } catch (e) { log('UPnP: IP externo indisponível ' + e.message); }

      let opened;
      let lease = 7200;
      try { opened = await addAll(lease); } catch (e) {
        // 725 = o roteador só aceita regras permanentes
        if (e.code === 725 || e.code === 402) { lease = 0; opened = await addAll(0); } else throw e;
      }
      clearInterval(renewTimer);
      if (lease) renewTimer = setInterval(() => addAll(lease).catch((e) => log('UPnP: renovação falhou ' + e.message)), 50 * 60 * 1000);

      const cgnat = !!externalIp && (isCgnat(externalIp) || isPrivate(externalIp));
      const status = conflicts.length ? 'partial' : 'ok';
      state = { status, externalIp, localIp, cgnat, opened, conflicts, router: svc.host };
      log(`UPnP: portas abertas ${opened.join(', ') || 'nenhuma'} -> ${localIp}; IP externo ${externalIp || '?'}${cgnat ? ' (CGNAT!)' : ''}${conflicts.length ? '; em uso por outro aparelho: ' + conflicts.join(', ') : ''}`);
      return state;
    } catch (e) {
      state = { status: 'error', error: e.message };
      log('UPnP: ' + e.message);
      return state;
    }
  }

  async function close() {
    clearInterval(renewTimer);
    if (!svc || !['ok', 'partial'].includes(state.status)) return;
    const mine = new Set(state.opened || []);
    await Promise.all(ports.filter((p) => mine.has(`${p.port}/${p.protocol}`)).map((p) => soap(svc, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: p.port, NewProtocol: p.protocol }).catch(() => {})));
    state = { status: 'idle' };
  }

  return { open, close, state: () => state };
}

module.exports = { createUpnp, isCgnat, isPrivate };
