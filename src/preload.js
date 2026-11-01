const { contextBridge, ipcRenderer } = require('electron');

const call = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const on = (ch) => (fn) => {
  const h = (_e, d) => fn(d);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('telao', {
  cfg: { get: call('cfg:get'), set: call('cfg:set') },
  invite: { read: call('invite:read') },
  authHeader: call('auth:header'),
  serverHost: call('server:host'),
  host: {
    start: call('host:start'), stop: call('host:stop'), status: call('host:status'),
    invite: call('host:invite'), inviteFor: call('host:inviteFor'), remember: call('invite:remember'),
    onState: on('host:state'), onLog: on('host:log'),
  },
  rooms: { list: call('rooms:list') },
  stream: {
    sources: call('stream:sources'), start: call('stream:start'), stop: call('stream:stop'), state: call('stream:state'),
    qualities: call('stream:qualities'), diagnose: call('stream:diagnose'), openLog: call('stream:openLog'),
    onState: on('stream:state'), onNotice: on('stream:notice'),
  },
  util: { copy: call('util:copy'), open: call('util:open') },
  win: { fullscreen: call('win:fullscreen'), onFullscreen: on('win:fullscreen') },
  ui: { onWatch: on('ui:watch') },
  net: { state: call('net:state'), retry: call('net:retry'), onState: on('net:state') },
  fw: { status: call('fw:status'), fix: call('fw:fix'), onState: on('fw:state') },
  upd: { state: call('upd:state'), check: call('upd:check'), relaunch: call('upd:relaunch'), onState: on('upd:state') },
});
