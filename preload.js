const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  ignore: (v) => ipcRenderer.send('ignore', v),
  drag: (m) => ipcRenderer.send('drag', m),
  set: (s) => ipcRenderer.send('set', s),
  pause: (p) => ipcRenderer.send('pause', p),
  close: () => ipcRenderer.send('close'),
  on: (ch, f) => ipcRenderer.on(ch, (_, d) => f(d)),
});
