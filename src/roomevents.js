// Telão — eventos ao vivo da sala (apontar, desenhar, reações, assistir junto).
// Mantém uma conexão por canal com o porteiro da sala (/telao/ev), reconecta sozinho e entrega cada evento.
function createRoomEvents({ baseUrl, authHeader, onEvent, log = () => {} }) {
  const chans = new Map(); // canal -> { ctrl, refs, retry }
  let clockOffset = 0;     // relógio do servidor - relógio daqui (ms)

  async function connect(ch) {
    const c = chans.get(ch);
    if (!c) return;
    const ctrl = new AbortController();
    c.ctrl = ctrl;
    try {
      const r = await fetch(`${baseUrl()}/telao/ev?ch=${encodeURIComponent(ch)}`, { headers: { Authorization: authHeader() }, signal: ctrl.signal });
      if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
      c.retry = 1000;
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
          if (!data) continue;
          let ev; try { ev = JSON.parse(data); } catch { continue; }
          if (typeof ev.now === 'number') clockOffset = ev.now - Date.now();
          if (ev.type !== 'hello') onEvent({ ch, ...ev });
        }
      }
    } catch (e) {
      if (ctrl.signal.aborted) return;
      if (c.retry >= 8000) log(`eventos (${ch}): ${e.message}`);
    }
    if (!chans.has(ch) || ctrl.signal.aborted) return;
    // caiu: tenta de novo (porteiro antigo sem eventos responde 404 -> espera mais)
    c.timer = setTimeout(() => connect(ch), c.retry);
    c.retry = Math.min(c.retry * 2, 30000);
  }

  return {
    sub(ch) {
      if (!ch) return;
      const c = chans.get(ch);
      if (c) { c.refs++; return; }
      chans.set(ch, { refs: 1, retry: 1000 });
      connect(ch);
    },
    unsub(ch) {
      const c = chans.get(ch);
      if (!c || --c.refs > 0) return;
      chans.delete(ch);
      clearTimeout(c.timer);
      try { c.ctrl && c.ctrl.abort(); } catch {}
    },
    // troca de sala: derruba e refaz todas as conexões
    reset() { for (const [ch, c] of chans) { clearTimeout(c.timer); try { c.ctrl && c.ctrl.abort(); } catch {} c.retry = 1000; connect(ch); } },
    async send(ev) {
      try {
        const r = await fetch(`${baseUrl()}/telao/ev`, {
          method: 'POST', headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
          body: JSON.stringify(ev), signal: AbortSignal.timeout(4000),
        });
        return r.ok;
      } catch { return false; }
    },
    serverNow: () => Date.now() + clockOffset,
  };
}
module.exports = { createRoomEvents };
