'use strict';

// Preload for our own chrome (topbar/bottombar/resize handles). Exposes a
// tiny, safe bridge.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ccc', {
  send: (channel, payload) => {
    const ok = [
      'ccc:newTab', 'ccc:closeTab', 'ccc:focusTab',
      'ccc:page', 'ccc:toggleSidebar', 'ccc:moveTab',
      'ccc:resizeStart', 'ccc:resizeMove', 'ccc:resizeEnd',
      'ccc:broadcast', 'ccc:toggleSolo', 'ccc:copyLast', 'ccc:topbarHeight'   // wq#4561
    ];
    if (ok.includes(channel)) ipcRenderer.send(channel, payload);
  },
  on: (channel, cb) => {
    const ok = ['tabs', 'usage', 'limit', 'resumed', 'deepseek', 'sysstats', 'fleet', 'tileStatus'];   // wq#4561
    if (ok.includes(channel)) ipcRenderer.on(channel, (_e, data) => cb(data));
  }
});
