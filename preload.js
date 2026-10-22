const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lxWidget", {
  hide: () => ipcRenderer.invoke("widget:hide"),
  minimize: () => ipcRenderer.invoke("widget:minimize"),
  togglePin: () => ipcRenderer.invoke("widget:toggle-pin"),
  isPinned: () => ipcRenderer.invoke("widget:is-pinned"),
  reload: () => ipcRenderer.invoke("widget:reload"),
  openFull: () => ipcRenderer.invoke("widget:open-full")
});
