const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = () => callback();
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('daymark', {
  load: () => ipcRenderer.invoke('store:load'),
  command: (command) => ipcRenderer.invoke('store:command', command),
  persistArchives: (dailyArchives) => ipcRenderer.invoke('store:persist-archives', dailyArchives),
  saveMarkdown: (payload) => ipcRenderer.invoke('reports:save-markdown', payload),
  exportData: (format) => ipcRenderer.invoke('store:export', format),
  getAiSettings: () => ipcRenderer.invoke('ai:get-settings'),
  saveAiSettings: (settings) => ipcRenderer.invoke('ai:save-settings', settings),
  setAiKey: (apiKey) => ipcRenderer.invoke('ai:set-key', { apiKey }),
  clearAiKey: () => ipcRenderer.invoke('ai:clear-key'),
  generateAiReport: (options) => ipcRenderer.invoke('ai:generate-report', options),
  cancelAiReport: (requestId) => ipcRenderer.invoke('ai:cancel', { requestId }),
  onFocusNewTask: (callback) => subscribe('app:focus-new-task', callback),
  onFocusSearch: (callback) => subscribe('app:focus-search', callback),
});
