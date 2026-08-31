'use strict';
// The dashboard is served over http://127.0.0.1, so it can't touch Node. This
// is the only bridge: a fixed set of desktop actions, no arbitrary access.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  available: true,
  info: () => ipcRenderer.invoke('wb:info'),
  pickFolder: (opts) => ipcRenderer.invoke('wb:pickFolder', opts || {}),
  openPath: (target) => ipcRenderer.invoke('wb:openPath', target),
  setStartup: (enabled) => ipcRenderer.invoke('wb:setStartup', !!enabled),
  restart: () => ipcRenderer.invoke('wb:restart'),
  checkUpdates: () => ipcRenderer.invoke('wb:checkUpdates'),
  updateStatus: () => ipcRenderer.invoke('wb:updateStatus'),
  installUpdate: () => ipcRenderer.invoke('wb:installUpdate'),
  quit: () => ipcRenderer.invoke('wb:quit'),
  migrate: (from) => ipcRenderer.invoke('wb:migrate', from),
  setAiKey: (key, provider) => ipcRenderer.invoke('wb:setAiKey', key, provider),
  hasAiKey: () => ipcRenderer.invoke('wb:hasAiKey'),
  copyDiagnostics: () => ipcRenderer.invoke('wb:copyDiagnostics'),
  onMigrateProgress: (fn) => {
    const handler = (_e, m) => fn(m);
    ipcRenderer.on('wb:migrate-progress', handler);
    return () => ipcRenderer.removeListener('wb:migrate-progress', handler);
  },
});
