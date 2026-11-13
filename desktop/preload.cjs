// Puente seguro entre la página (app/app.js) y el proceso principal del PC.
const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Map();
ipcRenderer.on('http-ev', (_e, id, type, data) => {
  const cb = listeners.get(id);
  if (!cb) return;
  if (type === 'end' || type === 'error') listeners.delete(id);
  cb(type, data);
});

contextBridge.exposeInMainWorld('neuraDesktop', {
  load: () => ipcRenderer.sendSync('store-load'),
  save: (text) => ipcRenderer.invoke('store-save', text),
  secure: () => ipcRenderer.sendSync('keyring'),
  request: (id, req, cb) => { listeners.set(id, cb); ipcRenderer.send('http', id, req); },
  abort: (id) => ipcRenderer.send('http-abort', id),
  bridge: () => ipcRenderer.sendSync('bridge-info'),
  setLan: (on) => ipcRenderer.invoke('set-lan', on),
  regenToken: () => ipcRenderer.invoke('regen-token'),
  gateway: (c) => ipcRenderer.invoke('gateway', c),
  addFolder: () => ipcRenderer.invoke('add-folder'),
  removeFolder: (dir) => ipcRenderer.invoke('remove-folder', dir),
  tailscale: (on) => ipcRenderer.invoke('tailscale', on),
  saveFile: (name, text) => ipcRenderer.invoke('save-file', name, text),
});
