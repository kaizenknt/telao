// Telão — ponte entre as abas e o app Telão aberto neste PC (ws://127.0.0.1, nunca sai do computador).
// Junta o que as páginas contam (melhor vídeo de cada aba) e manda para o Telão; repassa os comandos dele.
const PORTS = [47800, 47801, 47802];
let ws = null, pi = 0, retryT = null;
const tabs = new Map(); // tabId -> { url, title, at, frames: Map(frameId -> { score, state, noSeek, at }) }

function connect() {
  clearTimeout(retryT);
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  try { ws = new WebSocket(`ws://127.0.0.1:${PORTS[pi]}/telao`); } catch { return retry(); }
  ws.onopen = () => { send({ type: 'hello', ext: chrome.runtime.getManifest().version }); };
  ws.onmessage = (m) => {
    let c; try { c = JSON.parse(m.data); } catch { return; }
    if (c.type === 'cmd' && typeof c.tabId === 'number') {
      chrome.tabs.sendMessage(c.tabId, { t: 'cmd', cmd: c.cmd, time: c.time, v: c.v }, { frameId: c.frameId || 0 }).catch(() => {});
    }
    if (c.type === 'focus' && typeof c.tabId === 'number') chrome.tabs.update(c.tabId, { active: true }).catch(() => {});
  };
  ws.onclose = () => { ws = null; pi = (pi + 1) % PORTS.length; retry(); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}
function retry() { clearTimeout(retryT); retryT = setTimeout(connect, 2000); }
const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'telao') return;
  const tabId = port.sender && port.sender.tab && port.sender.tab.id;
  const frameId = (port.sender && port.sender.frameId) || 0;
  if (typeof tabId !== 'number') return;
  connect();
  port.onMessage.addListener((m) => {
    const now = Date.now();
    let t = tabs.get(tabId);
    if (!t) { t = { url: '', title: '', at: now, frames: new Map() }; tabs.set(tabId, t); }
    if (m.top) t.url = m.top;
    if (m.title) t.title = m.title;
    t.at = now;
    if (m.t === 'video') t.frames.set(frameId, { score: m.score, state: m.state, noSeek: !!m.noSeek, at: now });
    if (m.t === 'gone') t.frames.delete(frameId);
  });
  port.onDisconnect.addListener(() => {
    const t = tabs.get(tabId);
    if (t) { t.frames.delete(frameId); if (frameId === 0) tabs.delete(tabId); }
  });
});
chrome.tabs.onRemoved.addListener((id) => tabs.delete(id));

// a cada meio segundo: o melhor vídeo de cada aba
setInterval(() => {
  if (!ws || ws.readyState !== 1) return;
  const now = Date.now(), out = [];
  for (const [tabId, t] of tabs) {
    if (now - t.at > 6000) { tabs.delete(tabId); continue; }
    let bf = null, bid = 0;
    for (const [fid, f] of t.frames) {
      if (now - f.at > 2500) { t.frames.delete(fid); continue; }
      if (!bf || f.score > bf.score) { bf = f; bid = fid; }
    }
    out.push({ tabId, url: t.url, title: t.title, frameId: bid, video: bf ? { ...bf.state, noSeek: bf.noSeek } : null });
  }
  send({ type: 'tabs', tabs: out });
}, 500);

connect();
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.action.onClicked.addListener(() => connect());
