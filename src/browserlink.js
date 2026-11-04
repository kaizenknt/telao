// Telão — conversa com a extensão "Telão" no Chrome/Edge/Brave/Opera deste PC.
// Servidor WebSocket só em 127.0.0.1 (nada de fora do computador chega aqui) e só aceita extensões de navegador.
// Sem dependências: o protocolo WebSocket é pequeno o bastante para fazer aqui.
const http = require('http');
const crypto = require('crypto');

const PORTS = [47800, 47801, 47802];
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function createBrowserLink({ onTabs = () => {}, log = () => {} } = {}) {
  const clients = new Set();
  let server = null, port = null, lastTabs = [], lastAt = 0;

  function frame(text) {
    const data = Buffer.from(text);
    const len = data.length;
    const head = len < 126 ? Buffer.from([0x81, len])
      : len < 65536 ? Buffer.from([0x81, 126, len >> 8, len & 255])
      : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
    return Buffer.concat([head, data]);
  }

  function attach(sock) {
    let buf = Buffer.alloc(0);
    const client = { sock, send: (o) => { try { sock.write(frame(JSON.stringify(o))); } catch {} } };
    clients.add(client);
    const bye = () => { clients.delete(client); try { sock.destroy(); } catch {} if (!clients.size) { lastTabs = []; onTabs([], false); } };
    sock.on('close', bye); sock.on('error', bye);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 15, masked = buf[1] & 128;
        let len = buf[1] & 127, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (len > 1 << 20) return bye(); // nada legítimo é tão grande
        const need = off + (masked ? 4 : 0) + len;
        if (buf.length < need) return;
        let payload = buf.subarray(off + (masked ? 4 : 0), need);
        if (masked) { const k = buf.subarray(off, off + 4); payload = Buffer.from(payload.map((b, i) => b ^ k[i & 3])); }
        buf = buf.subarray(need);
        if (op === 8) return bye();
        if (op === 9) { try { sock.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); } catch {} continue; }
        if (op !== 1) continue;
        let m; try { m = JSON.parse(payload.toString()); } catch { continue; }
        if (m.type === 'tabs' && Array.isArray(m.tabs)) { lastTabs = m.tabs.slice(0, 50); lastAt = Date.now(); onTabs(lastTabs, true); }
        if (m.type === 'hello') log(`extensão do navegador conectada (v${m.ext || '?'})`);
      }
    });
  }

  function start(i = 0) {
    if (i >= PORTS.length) { log('extensão: nenhuma porta livre (47800-47802)'); return; }
    server = http.createServer((_q, r) => { r.writeHead(426); r.end('Telão'); });
    server.on('upgrade', (req, sock) => {
      const origin = String(req.headers.origin || '');
      const okOrigin = /^(chrome|moz|safari-web)-extension:\/\//.test(origin) || /^extension:\/\//.test(origin);
      const key = req.headers['sec-websocket-key'];
      if (!okOrigin || !key || req.socket.remoteAddress && !/^(::ffff:)?127\.0\.0\.1$|^::1$/.test(req.socket.remoteAddress)) {
        sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return;
      }
      const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
      sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      attach(sock);
    });
    server.once('error', () => { server = null; start(i + 1); });
    server.listen(PORTS[i], '127.0.0.1', () => { port = PORTS[i]; log(`extensão: esperando o navegador na porta ${port}`); });
  }

  return {
    start,
    connected: () => clients.size > 0,
    tabs: () => (Date.now() - lastAt < 3000 ? lastTabs : []),
    command(tabId, frameId, c) { for (const cl of clients) cl.send({ type: 'cmd', tabId, frameId, ...c }); return clients.size > 0; },
    focus(tabId) { for (const cl of clients) cl.send({ type: 'focus', tabId }); },
    stop() { for (const cl of clients) { try { cl.sock.destroy(); } catch {} } clients.clear(); if (server) server.close(); },
  };
}

module.exports = { createBrowserLink };
