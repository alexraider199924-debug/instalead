const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('instaleadDesktop', {
  isDesktop: true,
  profiles: {
    list: () => ipcRenderer.invoke('profiles:list'),
    create: data => ipcRenderer.invoke('profiles:create', data),
    update: data => ipcRenderer.invoke('profiles:update', data),
    remove: id => ipcRenderer.invoke('profiles:delete', id),
    open: (id, target = 'instagram') => ipcRenderer.invoke('profiles:open', id, target),
    testProxy: data => ipcRenderer.invoke('profiles:test-proxy', data)
  }
});
