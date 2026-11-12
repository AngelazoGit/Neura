// Puente seguro entre la página (app/app.js) y el proceso principal del PC.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('neuraDesktop', {
  load: () => ipcRenderer.sendSync('store-load'),
  save: (text) => ipcRenderer.invoke('store-save', text),
  fetch: (id, req) => ipcRenderer.invoke('http', id, req),
  abort: (id) => ipcRenderer.send('http-abort', id),
  bridge: () => ipcRenderer.sendSync('bridge-info'),
  setLan: (on) => ipcRenderer.invoke('set-lan', on),
});
