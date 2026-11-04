// Telão — "assistir junto" com qualquer site: controla o <video> de uma página aberta no navegador embutido.
// O vídeo de muitos sites fica dentro de um player em outro endereço (iframe); por isso procura em TODOS os
// quadros da página e fica com o maior vídeo (o que está tocando ganha). Só quem roda aqui é o processo
// principal do Telão — a página não ganha nenhum acesso ao app.
const { webContents } = require('electron');

const FIND = `(() => {
  const all = [...document.querySelectorAll('video')];
  let best = null, score = 0;
  for (const v of all) {
    const r = v.getBoundingClientRect();
    const area = Math.max(0, r.width) * Math.max(0, r.height);
    if (area < 120 * 70 && !(v.duration > 60)) continue; // vídeos minúsculos (anúncio, prévia) não contam
    const s = area * (v.readyState > 0 ? 1 : 0.2) + (v.paused ? 0 : 1e7) + (v.duration > 300 ? 5e6 : 0);
    if (s > score) { score = s; best = v; }
  }
  if (!best) return null;
  window.__telaoV = best;
  const d = best.duration;
  return { score, time: best.currentTime || 0, dur: isFinite(d) ? d : 0, live: d === Infinity, paused: best.paused, ended: best.ended, rs: best.readyState, vol: best.volume };
})()`;

const CMD = {
  play: () => 'v.play().catch(() => {})',
  pause: () => 'v.pause()',
  seek: (a) => `v.currentTime = ${Number(a.t) || 0}`,
  volume: (a) => `v.volume = ${Math.min(1, Math.max(0, Number(a.v) || 0))}; v.muted = ${Number(a.v) === 0}`,
};

const chosen = new Map(); // id do webContents -> quadro com o vídeo

const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);

async function probe(wcId) {
  const wc = webContents.fromId(wcId);
  if (!wc || wc.isDestroyed()) return { gone: true };
  let frames = [];
  try { frames = wc.mainFrame.framesInSubtree; } catch { return null; }
  const results = await Promise.all(frames.map((f) => withTimeout(f.executeJavaScript(FIND, false).then((r) => (r ? { f, r } : null)).catch(() => null), 600)));
  let best = null;
  for (const x of results) if (x && (!best || x.r.score > best.r.score)) best = x;
  if (!best) { chosen.delete(wcId); return { found: false }; }
  chosen.set(wcId, best.f);
  const { score, ...state } = best.r;
  return { found: true, ...state, frames: frames.length };
}

async function command(wcId, c) {
  const f = chosen.get(wcId);
  const make = CMD[c && c.cmd];
  if (!f || !make) return false;
  try { return !!(await f.executeJavaScript(`(() => { const v = window.__telaoV; if (!v) return false; ${make(c)}; return true; })()`, true)); }
  catch { chosen.delete(wcId); return false; }
}

// mesmo site? (ignora subdomínio: www.site.com e player.site.com são o mesmo site)
function baseDomain(host) {
  const p = String(host || '').toLowerCase().split('.').filter(Boolean);
  if (p.length <= 2) return p.join('.');
  const sld = p[p.length - 2];
  return (['com', 'net', 'org', 'gov', 'edu', 'co'].includes(sld) && p[p.length - 1].length === 2 ? p.slice(-3) : p.slice(-2)).join('.');
}

// regras para as páginas abertas no navegador embutido: sem janelas novas (anúncios), sem sair do site
function guard(wc) {
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  // o site de partida é onde a página TERMINA de carregar (muitos sites redirecionam para um espelho no começo)
  let start = null;
  wc.on('did-navigate', (_e, url) => { if (!start) start = url; });
  wc.on('did-finish-load', () => { if (!start) start = wc.getURL(); });
  const offSite = (url) => {
    if (!start) return false;
    try {
      const a = new URL(start), b = new URL(url);
      return !/^https?:$/.test(b.protocol) || baseDomain(b.hostname) !== baseDomain(a.hostname);
    } catch { return true; }
  };
  // a página principal não pode ir para outro site (clique em anúncio); os players dentro dela podem
  wc.on('will-navigate', (e, url) => { if (offSite(e.url || url)) e.preventDefault(); });
  wc.on('will-redirect', (e, url) => { if ((e.isMainFrame ?? true) && offSite(e.url || url)) e.preventDefault(); });
  wc.on('destroyed', () => chosen.delete(wc.id));
}

module.exports = { probe, command, guard, baseDomain };
