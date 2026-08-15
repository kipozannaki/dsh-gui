'use strict';
/**
 * preload.js — 安全桥接（contextBridge），渲染层只能通过 window.dshBridge 访问受控 API。
 * 注意：暴露名使用 dshBridge，避免与页面脚本中的标识符产生全局词法冲突。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshBridge', {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  onState: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('dsh:state', listener);
    return () => ipcRenderer.removeListener('dsh:state', listener);
  },
  onWebviewStatus: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('webview:status', listener);
    return () => ipcRenderer.removeListener('webview:status', listener);
  },
  onMaximized: (cb) => {
    const listener = (_e, v) => cb(v);
    ipcRenderer.on('win:maximized', listener);
    return () => ipcRenderer.removeListener('win:maximized', listener);
  },

  startService: () => ipcRenderer.invoke('service:start'),
  stopService: () => ipcRenderer.invoke('service:stop'),
  restartService: () => ipcRenderer.invoke('service:restart'),
  openBrowser: () => ipcRenderer.invoke('service:openBrowser'),
  reinstallDsh: () => ipcRenderer.invoke('service:install'),

  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),

  saveWallpaper: (buffer, ext) => ipcRenderer.invoke('wallpaper:save', buffer, ext),
  deleteWallpaper: (file) => ipcRenderer.invoke('wallpaper:delete', file),

  logTail: () => ipcRenderer.invoke('log:tail'),
  openPath: (kind) => ipcRenderer.invoke('path:open', kind),
  apiKeyStatus: () => ipcRenderer.invoke('api:keyStatus'),

  winMinimize: () => ipcRenderer.invoke('win:minimize'),
  winMaximizeToggle: () => ipcRenderer.invoke('win:maximizeToggle'),
  winHide: () => ipcRenderer.invoke('win:hide'),
  winQuit: () => ipcRenderer.invoke('win:quit'),
  winIsMaximized: () => ipcRenderer.invoke('win:isMaximized')
});
