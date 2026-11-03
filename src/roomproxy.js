// Telão — porteiro da sala. Fica na porta da API (9997), repassa tudo para o MediaMTX (que passa a ouvir só
// por dentro, em 9996) e acrescenta um cantinho para quem assiste contar como a transmissão está chegando:
//   POST /telao/fb   { path, viewer, verdict, loss, fps, av1 }   (a cada ~3 s, de quem assiste)
//   GET  /telao/fb?path=nome                                      (quem transmite lê)
//   GET  /telao/ping                                              (versão do porteiro)
//   GET  /telao/ev?ch=canal                                       (eventos ao vivo, text/event-stream)
//   POST /telao/ev   { ch, type, from, data, sticky? }            (manda um evento para todos do canal)
// Canais: "p:<transmissão>" (apontar, desenhar, reações) e "sala" (assistir junto).
// Sem dependências: roda no app (Electron) e também sozinho num servidor alugado (node roomproxy.js).
const http = require('http');

function createRoomProxy({ listenPort = 9997, targetPort = 9996, targetHost = '127.0.0.1', user = 'sala', getPassword, log = () => {} }) {
  const reports = new Map(); // "path\nviewer" -> { ...relato, t }
  const subs = new Map();    // canal -> Set(res)
  const sticky = new Map();  // canal -> último evento "fixo" (ex.: o vídeo que está passando no assistir junto)
  const TTL = 12000;
  let server = null;

  const authOk = (req) => {
    const h = String(req.headers.authorization || '');
    const m = h.match(/^Basic\s+(.+)$/i);
    if (!m) return false;
    const [u, ...rest] = Buffer.from(m[1], 'base64').toString().split(':');
    return u === user && rest.join(':') === String(getPassword() || '');
  };
  const json = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  const clean = (v, max = 60) => String(v == null ? '' : v).slice(0, max);
  const num = (v) => (Number.isFinite(+v) ? Math.round(+v * 10) / 10 : null);

  function handleOwn(req, res, url) {
    if (url.pathname === '/telao/ping') return json(res, 200, { ok: true, v: 2, now: Date.now() });
    if (!authOk(req)) return json(res, 401, { error: 'senha' });
    const now = Date.now();
    for (const [k, r] of reports) if (now - r.t > TTL) reports.delete(k);

    if (url.pathname === '/telao/fb' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        let o; try { o = JSON.parse(body); } catch { return json(res, 400, { error: 'json' }); }
        const path = clean(o.path, 80), viewer = clean(o.viewer);
        if (!path || !viewer) return json(res, 400, { error: 'faltou path/viewer' });
        reports.set(path + '\n' + viewer, {
          path, viewer, t: now,
          verdict: ['ok', 'rede', 'instavel', 'origem', 'local'].includes(o.verdict) ? o.verdict : null,
          loss: num(o.loss), fps: num(o.fps), av1: typeof o.av1 === 'boolean' ? o.av1 : null,
          layer: o.layer === 'leve' ? 'leve' : 'main', wantsLight: o.wantsLight === true,
        });
        json(res, 200, { ok: true });
      });
      return;
    }
    if (url.pathname === '/telao/fb' && req.method === 'GET') {
      const path = url.searchParams.get('path') || '';
      const items = [...reports.values()].filter((r) => !path || r.path === path).map(({ t, ...r }) => ({ ...r, age: now - t }));
      return json(res, 200, { items });
    }
    // ---- eventos ao vivo ----
    if (url.pathname === '/telao/ev' && req.method === 'GET') {
      const ch = clean(url.searchParams.get('ch'), 100);
      if (!ch) return json(res, 400, { error: 'faltou ch' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`retry: 2000\ndata: ${JSON.stringify({ type: 'hello', now: Date.now() })}\n\n`);
      const st = sticky.get(ch);
      if (st) res.write(`data: ${JSON.stringify({ ...st, now: Date.now(), replay: true })}\n\n`);
      if (!subs.has(ch)) subs.set(ch, new Set());
      subs.get(ch).add(res);
      const beat = setInterval(() => res.write(`: ${Date.now()}\n\n`), 15000);
      req.on('close', () => { clearInterval(beat); const set = subs.get(ch); if (set) { set.delete(res); if (!set.size) subs.delete(ch); } });
      return;
    }
    if (url.pathname === '/telao/ev' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 16384) req.destroy(); });
      req.on('end', () => {
        let o; try { o = JSON.parse(body); } catch { return json(res, 400, { error: 'json' }); }
        const ch = clean(o.ch, 100), type = clean(o.type, 30);
        if (!ch || !type) return json(res, 400, { error: 'faltou ch/type' });
        const ev = { type, from: clean(o.from), data: o.data === undefined ? null : o.data, t: Date.now() };
        if (o.sticky) sticky.set(ch, ev);
        if (o.clearSticky) sticky.delete(ch);
        const line = `data: ${JSON.stringify({ ...ev, now: Date.now() })}\n\n`;
        for (const r of subs.get(ch) || []) r.write(line);
        json(res, 200, { ok: true, n: (subs.get(ch) || new Set()).size });
      });
      return;
    }
    json(res, 404, { error: 'não existe' });
  }

  function forward(req, res) {
    const up = http.request({ host: targetHost, port: targetPort, method: req.method, path: req.url, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    });
    up.setTimeout(10000, () => up.destroy(new Error('timeout')));
    up.on('error', (e) => { if (!res.headersSent) json(res, 502, { error: 'servidor da sala não respondeu: ' + e.message }); else res.destroy(); });
    req.pipe(up);
  }

  return {
    start() {
      return new Promise((resolve, reject) => {
        server = http.createServer((req, res) => {
          let url; try { url = new URL(req.url, 'http://x'); } catch { return json(res, 400, {}); }
          if (url.pathname.startsWith('/telao/')) return handleOwn(req, res, url);
          forward(req, res);
        });
        server.once('error', reject);
        server.listen(listenPort, '0.0.0.0', () => { log(`[porteiro] ouvindo na ${listenPort}`); resolve(); });
      });
    },
    stop() {
      for (const set of subs.values()) for (const r of set) { try { r.end(); } catch {} }
      subs.clear();
      return new Promise((resolve) => { if (!server) return resolve(); server.close(() => resolve()); if (server.closeAllConnections) server.closeAllConnections(); server = null; });
    },
  };
}

module.exports = { createRoomProxy };

// rodando sozinho (servidor alugado): SENHA=... node roomproxy.js
if (require.main === module) {
  const pass = process.env.SENHA || process.env.TELAO_SENHA;
  if (!pass) { console.error('Defina a senha da sala: SENHA=suasenha node roomproxy.js'); process.exit(1); }
  createRoomProxy({ getPassword: () => pass, log: console.log }).start().catch((e) => { console.error(e.message); process.exit(1); });
}
